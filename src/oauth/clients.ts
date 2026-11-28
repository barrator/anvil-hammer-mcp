/**
 * Who may ask for authorization. Two sources, no dynamic registration:
 * - Client ID Metadata Documents (CIMD): the client_id is an https URL on an
 *   allowlisted host (default claude.ai); see cimd.ts.
 * - Pre-registered public clients listed in <oauth dir>/clients.json, created
 *   with `anvil-hammer-mcp add-client`. Empty by default.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ConfigError } from "../config/errors.js";
import { CimdError, type CimdRefusal, type CimdResolver, isUrlClientId } from "./cimd.js";
import { isAllowedRedirectForm } from "./redirects.js";

export interface PreregisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

const CLIENT_ID = /^[A-Za-z0-9._~-]{8,128}$/;
const CLIENT_KEYS = new Set(["client_id", "client_name", "redirect_uris"]);

export function newClientId(): string {
  return `ahm-${randomBytes(16).toString("base64url")}`;
}

/** Parse and check clients.json. Public clients only: no secret field is accepted. */
export function parseClientsFile(text: string, file = "clients.json"): PreregisteredClient[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file} is not valid JSON.`);
  }
  const list = (data as { clients?: unknown } | null)?.clients;
  if (!data || typeof data !== "object" || !Array.isArray(list))
    throw new ConfigError(`${file} must look like {"clients": [...]}.`);
  const seen = new Set<string>();
  return list.map((c: unknown, i) => {
    const where = `${file}, client ${i + 1}`;
    if (!c || typeof c !== "object" || Array.isArray(c))
      throw new ConfigError(`${where}: not an object.`);
    const o = c as Record<string, unknown>;
    for (const k of Object.keys(o))
      if (!CLIENT_KEYS.has(k))
        throw new ConfigError(
          `${where}: unknown key "${k}". Only public clients are supported (client_id, client_name, redirect_uris).`,
        );
    const id = o.client_id;
    if (typeof id !== "string" || !CLIENT_ID.test(id) || isUrlClientId(id))
      throw new ConfigError(`${where}: client_id must be 8-128 letters, digits or ._~-`);
    if (seen.has(id)) throw new ConfigError(`${where}: duplicate client_id.`);
    seen.add(id);
    const name = o.client_name;
    if (typeof name !== "string" || !name.trim() || name.length > 100)
      throw new ConfigError(`${where}: client_name must be a short text.`);
    const uris = o.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0)
      throw new ConfigError(`${where}: redirect_uris must list at least one URI.`);
    for (const u of uris)
      if (typeof u !== "string" || !isAllowedRedirectForm(u))
        throw new ConfigError(
          `${where}: every redirect URI must be https, or http on localhost/127.0.0.1.`,
        );
    return { client_id: id, client_name: name.trim(), redirect_uris: uris as string[] };
  });
}

export type ClientSource = "cimd" | "preregistered";

export interface ResolvedClient {
  client: OAuthClientInformationFull;
  source: ClientSource;
}

export type ClientLookup =
  | { ok: true; client: OAuthClientInformationFull; source: ClientSource }
  | { ok: false; message: string; reason: CimdRefusal | "unknown_client" | "cimd_disabled" };

export class ClientRegistry implements OAuthRegisteredClientsStore {
  private clients: PreregisteredClient[] = [];
  private loadedMtime = -1;

  constructor(
    private readonly clientsFile: string,
    private readonly cimd: CimdResolver | undefined,
    private readonly onReloadError: (message: string) => void = () => {},
  ) {
    this.reload(true);
  }

  get cimdEnabled(): boolean {
    return !!this.cimd && this.cimd.hosts.length > 0;
  }

  /** Re-read clients.json when it changed, so add-client needs no restart. */
  private reload(strict = false): void {
    let mtime: number;
    try {
      mtime = statSync(this.clientsFile).mtimeMs;
    } catch {
      this.clients = [];
      this.loadedMtime = -1;
      return;
    }
    if (mtime === this.loadedMtime) return;
    try {
      this.clients = parseClientsFile(readFileSync(this.clientsFile, "utf8"), this.clientsFile);
      this.loadedMtime = mtime;
    } catch (err) {
      if (strict) throw err;
      // Keep the previous list; a bad edit must not lock the owner out.
      this.onReloadError(err instanceof Error ? err.message : String(err));
      this.loadedMtime = mtime;
    }
  }

  async lookup(clientId: string): Promise<ClientLookup> {
    if (isUrlClientId(clientId)) {
      if (!this.cimd || !this.cimdEnabled)
        return {
          ok: false,
          reason: "cimd_disabled",
          message: "This server does not accept client metadata documents.",
        };
      try {
        return { ok: true, client: await this.cimd.resolve(clientId), source: "cimd" };
      } catch (err) {
        if (err instanceof CimdError)
          return { ok: false, reason: err.reason, message: err.message };
        return {
          ok: false,
          reason: "fetch_failed",
          message: "The client metadata document could not be fetched.",
        };
      }
    }
    this.reload();
    const c = this.clients.find((x) => x.client_id === clientId);
    if (!c) return { ok: false, reason: "unknown_client", message: "Unknown client." };
    return {
      ok: true,
      source: "preregistered",
      client: {
        ...c,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    };
  }

  /** For the SDK's token and revocation handlers. */
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const r = await this.lookup(clientId);
    return r.ok ? r.client : undefined;
  }
}
