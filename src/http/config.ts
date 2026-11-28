/**
 * Hosted-mode settings (environment variables). Secrets are files only; this
 * module reads paths and plain settings, never key values.
 */
import { homedir } from "node:os";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "../config/errors.js";
import { SERVER_NAME } from "../constants.js";
import {
  DEFAULT_REDIRECT_URIS,
  LOOPBACK_HOSTS,
  isAllowedRedirectForm,
} from "../oauth/redirects.js";
import { DEFAULT_LOG_RETENTION_DAYS } from "./techlog.js";

type Env = Record<string, string | undefined>;

export interface HttpConfig {
  /** Public origin, also the OAuth issuer: https://host[:port], no trailing slash. */
  publicUrl: string;
  /** Host name the Host header must carry. */
  publicHostname: string;
  listenHost: string;
  port: number;
  passphraseFile: string;
  oauthDir: string;
  logDir: string;
  logRetentionDays: number;
  /** Optional: only checked by /healthz until stage F uses it. */
  indexDir?: string;
  /** Hosts whose client metadata documents are accepted; empty disables CIMD. */
  cimdHosts: string[];
  /** Redirect URIs accepted from metadata-document clients. */
  redirectUris: string[];
  /** Addresses whose X-Forwarded-For header is trusted (the gateway). */
  trustedProxies: string[];
}

function dataDir(env: Env, home = homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, SERVER_NAME);
}

/** The OAuth state folder (grants, clients.json, revoke marker), for the CLI commands too. */
export function resolveOauthDir(env: Env = process.env): string {
  const v = env.WA_OAUTH_DIR?.trim();
  return v ? resolve(v) : join(dataDir(env), "oauth");
}

function list(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePublicUrl(raw: string | undefined): { origin: string; hostname: string } {
  if (!raw?.trim())
    throw new ConfigError(
      "WA_PUBLIC_URL is required in hosted mode: the https address of this server, e.g. https://wa.example.com",
    );
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError("WA_PUBLIC_URL is not a valid URL.");
  }
  const local = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !local)
    throw new ConfigError("WA_PUBLIC_URL must use https (http is accepted for localhost only).");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password)
    throw new ConfigError("WA_PUBLIC_URL must be an origin only, without path, query or user.");
  return { origin: u.origin, hostname: u.hostname };
}

function intVar(env: Env, name: string, min: number, max: number, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  return n;
}

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  const { origin, hostname } = parsePublicUrl(env.WA_PUBLIC_URL);
  const passphraseFile = env.WA_PASSPHRASE_FILE?.trim();
  if (!passphraseFile)
    throw new ConfigError(
      "WA_PASSPHRASE_FILE is required in hosted mode (a file holding the output of hash-passphrase).",
    );
  const base = dataDir(env);
  const dir = (name: string, fallback: string) => {
    const v = env[name]?.trim();
    return v ? resolve(v) : fallback;
  };

  const cimdRaw = env.WA_OAUTH_CIMD_HOSTS?.trim().toLowerCase();
  const cimdHosts = cimdRaw === "none" ? [] : (list(cimdRaw) ?? ["claude.ai"]);
  for (const h of cimdHosts)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h))
      throw new ConfigError(`WA_OAUTH_CIMD_HOSTS: "${h}" is not a host name.`);

  const redirectUris = list(env.WA_OAUTH_REDIRECT_URIS) ?? [...DEFAULT_REDIRECT_URIS];
  for (const u of redirectUris)
    if (!isAllowedRedirectForm(u))
      throw new ConfigError(
        `WA_OAUTH_REDIRECT_URIS: "${u}" must be https, or http on localhost/127.0.0.1.`,
      );

  const trustedProxies = list(env.WA_TRUSTED_PROXY) ?? [];
  for (const ip of trustedProxies)
    if (!isIP(ip)) throw new ConfigError(`WA_TRUSTED_PROXY: "${ip}" is not an IP address.`);

  const indexDir = env.WA_INDEX_DIR?.trim();
  return {
    publicUrl: origin,
    publicHostname: hostname,
    listenHost: env.WA_HTTP_HOST?.trim() || "127.0.0.1",
    port: intVar(env, "WA_HTTP_PORT", 1, 65535, 8080),
    passphraseFile,
    oauthDir: resolveOauthDir(env),
    logDir: dir("WA_LOG_DIR", join(base, "logs")),
    logRetentionDays: intVar(env, "WA_LOG_RETENTION_DAYS", 1, 3650, DEFAULT_LOG_RETENTION_DAYS),
    ...(indexDir ? { indexDir: resolve(indexDir) } : {}),
    cimdHosts,
    redirectUris,
    trustedProxies,
  };
}
