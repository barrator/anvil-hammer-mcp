/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document,
 * MCP authorization spec "Client Registration"). A client_id that is an https
 * URL names a JSON document describing the client; the server fetches it.
 *
 * Fetching a URL chosen by the request is a server-side request forgery risk,
 * so the fetch is narrow: allowlisted hosts only, https on the default port,
 * no redirect followed, 5 s, 5 KB, JSON only. The gateway allows the same hosts.
 */
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { isAllowedRedirectForm } from "./redirects.js";

export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 5 * 1024;

export type CimdRefusal =
  | "not_https"
  | "invalid_url"
  | "host_not_allowed"
  | "redirect"
  | "http_status"
  | "not_json"
  | "too_large"
  | "timeout"
  | "fetch_failed"
  | "invalid_document"
  | "client_id_mismatch"
  | "auth_method";

export class CimdError extends Error {
  override name = "CimdError";
  constructor(
    readonly reason: CimdRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** A client_id that looks like a URL is handled as a metadata document, never as a plain id. */
export function isUrlClientId(clientId: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(clientId);
}

export interface CimdOptions {
  /** Hosts whose documents are accepted, lowercase, exact match. */
  hosts: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  maxEntries?: number;
  /** Cache lifetime when the response has no caching header. */
  defaultTtlMs?: number;
  maxTtlMs?: number;
}

interface CacheEntry {
  client: OAuthClientInformationFull;
  expiresAt: number;
}

/** Cache lifetime from Cache-Control: no-store/no-cache/max-age=0 → not cached. */
export function cacheTtlMs(header: string | null, defaultMs: number, maxMs: number): number {
  if (!header) return defaultMs;
  const directives = header
    .toLowerCase()
    .split(",")
    .map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache")) return 0;
  const maxAge = directives.find((d) => d.startsWith("max-age="));
  if (maxAge) {
    const n = Number(maxAge.slice("max-age=".length));
    if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, maxMs);
  }
  return defaultMs;
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

/** Validate a fetched document against the URL it came from. */
export function validateDocument(clientId: string, doc: unknown): OAuthClientInformationFull {
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new CimdError("invalid_document", "The client metadata document is not a JSON object.");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId)
    throw new CimdError(
      "client_id_mismatch",
      "The document's client_id does not match the URL it was fetched from.",
    );
  if (!str(d.client_name) || !d.client_name.trim() || d.client_name.length > 200)
    throw new CimdError("invalid_document", "The document has no valid client_name.");
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0)
    throw new CimdError("invalid_document", "The document has no redirect_uris.");
  if (!d.redirect_uris.every((u) => str(u) && isAllowedRedirectForm(u)))
    throw new CimdError(
      "invalid_document",
      "Every redirect URI in the document must be https or a localhost address.",
    );
  if (d.token_endpoint_auth_method !== "none")
    throw new CimdError(
      "auth_method",
      'Only public clients are accepted: token_endpoint_auth_method must be "none".',
    );
  if ("client_secret" in d)
    throw new CimdError("invalid_document", "A client metadata document must not hold a secret.");
  if (
    d.grant_types !== undefined &&
    !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))
  )
    throw new CimdError("invalid_document", "The document does not allow authorization_code.");
  if (
    d.response_types !== undefined &&
    !(Array.isArray(d.response_types) && d.response_types.includes("code"))
  )
    throw new CimdError("invalid_document", 'The document does not allow response type "code".');
  return {
    client_id: clientId,
    client_name: d.client_name.trim(),
    redirect_uris: d.redirect_uris as string[],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/** Check the client_id URL before any network call. Returns the parsed URL. */
export function checkClientIdUrl(clientId: string, hosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdError("invalid_url", "The client_id is not a valid URL.");
  }
  if (url.protocol !== "https:")
    throw new CimdError("not_https", "A client_id URL must use https.");
  // The canonical form must be the string itself: no default port, no case
  // folding, no dot segments, no credentials, no fragment.
  if (url.href !== clientId || url.port || url.username || url.password || url.hash)
    throw new CimdError("invalid_url", "The client_id URL is not in canonical form.");
  if (url.pathname === "/" || url.pathname === "")
    throw new CimdError("invalid_url", "A client_id URL must have a path.");
  if (!hosts.includes(url.hostname))
    throw new CimdError(
      "host_not_allowed",
      `Client metadata documents from ${url.hostname} are not accepted by this server.`,
    );
  return url;
}

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max)
    throw new CimdError("too_large", `The client metadata document is larger than ${max} bytes.`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new CimdError("too_large", `The client metadata document is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class CimdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<OAuthClientInformationFull>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: CimdOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get hosts(): readonly string[] {
    return this.o.hosts;
  }

  async resolve(clientId: string): Promise<OAuthClientInformationFull> {
    const url = checkClientIdUrl(clientId, this.o.hosts);
    const hit = this.cache.get(clientId);
    if (hit && hit.expiresAt > this.now()) return hit.client;
    if (hit) this.cache.delete(clientId);
    const pending = this.inFlight.get(clientId);
    if (pending) return pending;
    const p = this.fetchDocument(url, clientId).finally(() => this.inFlight.delete(clientId));
    this.inFlight.set(clientId, p);
    return p;
  }

  private async fetchDocument(url: URL, clientId: string): Promise<OAuthClientInformationFull> {
    const timeoutMs = this.o.timeoutMs ?? CIMD_TIMEOUT_MS;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new CimdError(
        timedOut ? "timeout" : "fetch_failed",
        timedOut
          ? `The client metadata document did not arrive within ${timeoutMs / 1000} s.`
          : "The client metadata document could not be fetched.",
      );
    }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect")
      throw new CimdError("redirect", "The client metadata URL redirects; redirects are refused.");
    if (res.status !== 200)
      throw new CimdError("http_status", `The client metadata URL answered HTTP ${res.status}.`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(type))
      throw new CimdError("not_json", "The client metadata document is not served as JSON.");
    let body: string;
    try {
      body = await readLimited(res, this.o.maxBytes ?? CIMD_MAX_BYTES);
    } catch (err) {
      if (err instanceof CimdError) throw err;
      throw new CimdError("fetch_failed", "The client metadata document could not be read.");
    }
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      throw new CimdError("not_json", "The client metadata document is not valid JSON.");
    }
    const client = validateDocument(clientId, doc);
    const ttl = cacheTtlMs(
      res.headers.get("cache-control"),
      this.o.defaultTtlMs ?? 5 * 60_000,
      this.o.maxTtlMs ?? 24 * 60 * 60_000,
    );
    if (ttl > 0) {
      const max = this.o.maxEntries ?? 32;
      while (this.cache.size >= max) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.cache.set(clientId, { client, expiresAt: this.now() + ttl });
    }
    return client;
  }
}
