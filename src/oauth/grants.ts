/**
 * Authorization codes, access tokens and refresh tokens.
 *
 * - Tokens are opaque random strings; only their SHA-256 hashes are kept.
 * - Codes and access tokens live in memory (after a restart, Claude refreshes
 *   on the 401). Refresh tokens are persisted in <oauth dir>/grants.json
 *   (mode 0600, atomic write) so a restart does not force a new sign-in.
 * - One grant ("family") per authorization. Each refresh rotates the refresh
 *   token and returns the new one in the same response. Presenting a rotated
 *   token again revokes the whole family, except within a short grace period
 *   (a response lost in transit).
 * - `revoke-all` writes a marker file; every family older than the marker is
 *   revoked, by a running server as well as at the next start.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const MCP_SCOPE = "mcp";
export const OFFLINE_SCOPE = "offline_access";

export interface GrantLimits {
  codeTtlSec: number;
  accessTtlSec: number;
  refreshIdleSec: number;
  refreshMaxSec: number;
  graceSec: number;
  maxFamilies: number;
}

export const DEFAULT_GRANT_LIMITS: GrantLimits = {
  codeTtlSec: 5 * 60,
  accessTtlSec: 30 * 60,
  refreshIdleSec: 30 * 24 * 3600,
  refreshMaxSec: 90 * 24 * 3600,
  graceSec: 60,
  maxFamilies: 50,
};

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  used: boolean;
  family?: string;
}

interface Family {
  id: string;
  clientId: string;
  scopes: string[];
  resource: string;
  createdAt: number;
  lastUsedAt: number;
  current: string;
  previous?: string;
  rotatedAt?: number;
}

interface AccessRecord {
  family: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export type GrantEvent =
  | { kind: "token_issued"; clientId: string }
  | { kind: "token_refreshed"; clientId: string }
  | { kind: "refresh_reuse_revoked"; clientId: string }
  | { kind: "refresh_rejected"; clientId: string; reason: string }
  | { kind: "code_reuse_revoked"; clientId: string }
  | { kind: "revoked"; clientId: string }
  | { kind: "revoke_all"; families: number };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string, bytes = 32) =>
  `${prefix}${randomBytes(bytes).toString("base64url")}`;

export const GRANTS_FILE = "grants.json";
export const REVOKE_MARKER = "revoke-all";

/** Write the revoke-all marker (used by the CLI; the server picks it up). */
export function writeRevokeMarker(dir: string, now = Date.now()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, REVOKE_MARKER), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

export class GrantStore {
  private readonly codes = new Map<string, CodeRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private readonly families = new Map<string, Family>();
  private readonly file: string;
  private readonly marker: string;
  private markerSeen = 0;
  private readonly limits: GrantLimits;

  constructor(
    private readonly dir: string,
    private readonly o: {
      now?: () => number;
      limits?: Partial<GrantLimits>;
      onEvent?: (e: GrantEvent) => void;
    } = {},
  ) {
    this.limits = { ...DEFAULT_GRANT_LIMITS, ...o.limits };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, GRANTS_FILE);
    this.marker = join(dir, REVOKE_MARKER);
    this.load();
    this.checkMarker();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private emit(e: GrantEvent): void {
    this.o.onEvent?.(e);
  }

  get familyCount(): number {
    return this.families.size;
  }

  // ---------- persistence ----------

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    const data = JSON.parse(raw) as { version?: number; families?: Family[] };
    if (data.version !== 1 || !Array.isArray(data.families))
      throw new Error(`${this.file} has an unknown format.`);
    for (const f of data.families) if (!this.expired(f)) this.families.set(f.id, f);
  }

  private save(): void {
    const families = [...this.families.values()];
    writeAtomic(this.file, JSON.stringify({ version: 1, families }, null, 2) + "\n");
  }

  /** Apply a revoke-all marker written by the CLI. Cheap: one stat. */
  private checkMarker(): void {
    let mtime: number;
    try {
      mtime = statSync(this.marker).mtimeMs;
    } catch {
      return;
    }
    if (mtime <= this.markerSeen) return;
    this.markerSeen = mtime;
    let n = 0;
    for (const f of [...this.families.values()])
      if (f.createdAt <= mtime) {
        this.dropFamily(f.id);
        n++;
      }
    for (const [h, c] of this.codes)
      if (c.expiresAt - this.limits.codeTtlSec * 1000 <= mtime) this.codes.delete(h);
    if (n) {
      this.save();
      this.emit({ kind: "revoke_all", families: n });
    }
  }

  private expired(f: Family): boolean {
    const now = this.now();
    return (
      now > f.lastUsedAt + this.limits.refreshIdleSec * 1000 ||
      now > f.createdAt + this.limits.refreshMaxSec * 1000
    );
  }

  private dropFamily(id: string): void {
    this.families.delete(id);
    for (const [h, a] of this.access) if (a.family === id) this.access.delete(h);
  }

  /** Revoke every grant now (same effect as the CLI marker). */
  revokeAll(): number {
    const n = this.families.size;
    for (const id of [...this.families.keys()]) this.dropFamily(id);
    this.codes.clear();
    this.save();
    this.emit({ kind: "revoke_all", families: n });
    return n;
  }

  // ---------- authorization codes ----------

  createCode(c: Omit<CodeRecord, "expiresAt" | "used" | "family">): string {
    this.checkMarker();
    const code = token("ac_");
    this.codes.set(sha256(code), {
      ...c,
      expiresAt: this.now() + this.limits.codeTtlSec * 1000,
      used: false,
    });
    // Bound memory: drop expired codes.
    for (const [h, r] of this.codes) if (r.expiresAt < this.now()) this.codes.delete(h);
    return code;
  }

  private findCode(clientId: string, code: string): CodeRecord {
    const r = this.codes.get(sha256(code));
    if (!r || r.clientId !== clientId)
      throw new InvalidGrantError("The authorization code is invalid.");
    if (r.expiresAt < this.now()) {
      this.codes.delete(sha256(code));
      throw new InvalidGrantError("The authorization code has expired.");
    }
    return r;
  }

  challengeFor(clientId: string, code: string): string {
    this.checkMarker();
    return this.findCode(clientId, code).codeChallenge;
  }

  exchangeCode(
    clientId: string,
    code: string,
    redirectUri: string | undefined,
    resource: string | undefined,
  ): OAuthTokens {
    this.checkMarker();
    const r = this.findCode(clientId, code);
    if (r.used) {
      // A code presented twice: revoke what the first use produced (OAuth 2.1).
      if (r.family && this.families.has(r.family)) {
        this.dropFamily(r.family);
        this.save();
      }
      this.emit({ kind: "code_reuse_revoked", clientId });
      throw new InvalidGrantError("The authorization code was already used.");
    }
    if (redirectUri !== undefined && redirectUri !== r.redirectUri)
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource !== undefined && resource !== r.resource)
      throw new InvalidTargetError("The resource does not match the authorization request.");
    r.used = true;
    const now = this.now();
    const id = randomBytes(16).toString("base64url");
    const refresh = `rt_${id}.${randomBytes(32).toString("base64url")}`;
    this.makeRoom();
    this.families.set(id, {
      id,
      clientId,
      scopes: r.scopes,
      resource: r.resource,
      createdAt: now,
      lastUsedAt: now,
      current: sha256(refresh),
    });
    r.family = id;
    this.save();
    this.emit({ kind: "token_issued", clientId });
    return this.issue(id, clientId, r.scopes, r.resource, refresh);
  }

  /** Keep at most maxFamilies grants: drop the least recently used. */
  private makeRoom(): void {
    while (this.families.size >= this.limits.maxFamilies) {
      let oldest: Family | undefined;
      for (const f of this.families.values())
        if (!oldest || f.lastUsedAt < oldest.lastUsedAt) oldest = f;
      if (!oldest) return;
      this.dropFamily(oldest.id);
    }
  }

  private issue(
    family: string,
    clientId: string,
    scopes: string[],
    resource: string,
    refresh: string,
  ): OAuthTokens {
    const access = token("at_");
    const expiresAt = this.now() + this.limits.accessTtlSec * 1000;
    this.access.set(sha256(access), { family, clientId, scopes, resource, expiresAt });
    for (const [h, a] of this.access) if (a.expiresAt < this.now()) this.access.delete(h);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.limits.accessTtlSec,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  // ---------- refresh ----------

  refresh(
    clientId: string,
    refreshToken: string,
    scopes: string[] | undefined,
    resource: string | undefined,
  ): OAuthTokens {
    this.checkMarker();
    const m = /^rt_([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/.exec(refreshToken);
    const f = m?.[1] ? this.families.get(m[1]) : undefined;
    const reject = (reason: string) => {
      this.emit({ kind: "refresh_rejected", clientId, reason });
      return new InvalidGrantError("The refresh token is invalid, expired or revoked.");
    };
    if (!f) throw reject("unknown");
    if (f.clientId !== clientId) throw reject("client_mismatch");
    if (this.expired(f)) {
      this.dropFamily(f.id);
      this.save();
      throw reject("expired");
    }
    const h = sha256(refreshToken);
    const now = this.now();
    const inGrace =
      h === f.previous &&
      f.rotatedAt !== undefined &&
      now - f.rotatedAt <= this.limits.graceSec * 1000;
    if (h !== f.current && !inGrace) {
      // A rotated token came back: it may have been stolen. Revoke the grant.
      this.dropFamily(f.id);
      this.save();
      this.emit({ kind: "refresh_reuse_revoked", clientId });
      throw new InvalidGrantError("The refresh token is invalid, expired or revoked.");
    }
    if (scopes?.some((s) => !f.scopes.includes(s)))
      throw new InvalidScopeError("The requested scope exceeds the original grant.");
    if (resource !== undefined && resource !== f.resource)
      throw new InvalidTargetError("The resource does not match the original grant.");
    const next = `rt_${f.id}.${randomBytes(32).toString("base64url")}`;
    if (!inGrace) {
      f.previous = f.current;
      f.rotatedAt = now;
    }
    f.current = sha256(next);
    f.lastUsedAt = now;
    this.save();
    this.emit({ kind: "token_refreshed", clientId });
    return this.issue(f.id, clientId, scopes ?? f.scopes, f.resource, next);
  }

  // ---------- access tokens ----------

  verifyAccess(accessToken: string): AuthInfo {
    this.checkMarker();
    const a = this.access.get(sha256(accessToken));
    if (!a || !this.families.has(a.family))
      throw new InvalidTokenError("The access token is invalid or revoked.");
    if (a.expiresAt < this.now()) {
      this.access.delete(sha256(accessToken));
      throw new InvalidTokenError("The access token has expired.");
    }
    return {
      token: accessToken,
      clientId: a.clientId,
      scopes: a.scopes,
      expiresAt: Math.floor(a.expiresAt / 1000),
      resource: new URL(a.resource),
      extra: { family: a.family },
    };
  }

  /** RFC 7009: revoke the grant behind an access or refresh token of this client. */
  revoke(clientId: string, tokenValue: string): void {
    this.checkMarker();
    let family: string | undefined;
    const a = this.access.get(sha256(tokenValue));
    if (a && a.clientId === clientId) family = a.family;
    const m = /^rt_([A-Za-z0-9_-]{22})\./.exec(tokenValue);
    if (!family && m?.[1]) {
      const f = this.families.get(m[1]);
      if (f && f.clientId === clientId) {
        const h = sha256(tokenValue);
        if (h === f.current || h === f.previous) family = f.id;
      }
    }
    if (!family || !this.families.has(family)) return; // unknown tokens: no error (RFC 7009)
    this.dropFamily(family);
    this.save();
    this.emit({ kind: "revoked", clientId });
  }
}
