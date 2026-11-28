import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_MAX_RESPONSE_CHARS, SERVER_NAME } from "../constants.js";
import { type AccessPolicy, loadAccessPolicy } from "./access.js";
import { ConfigError } from "./errors.js";
import { loadSecrets, type Secrets } from "./secrets.js";

export interface Config {
  secrets: Secrets;
  access: AccessPolicy;
  maxResponseChars: number;
  /** Absolute path of the backups folder. */
  backupDir: string;
  backupRetentionDays: number;
  /** Expose wa_delete. Off by default. */
  enableDelete: boolean;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_BACKUP_RETENTION_DAYS = 90;

function intVar(env: Env, name: string, min: number, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new ConfigError(`${name} must be an integer of at least ${min}.`);
  return n;
}

function boolVar(env: Env, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  throw new ConfigError(`${name} must be "true" or "false".`);
}

/**
 * Default backups folder: the user's data folder, never the current directory.
 * $XDG_DATA_HOME/anvil-hammer-mcp/backups, else ~/.local/share/anvil-hammer-mcp/backups.
 */
export function defaultBackupDir(env: Env, home = homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  // The XDG spec says relative values must be ignored.
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, SERVER_NAME, "backups");
}

export function loadConfig(env: Env = process.env): Config {
  const secrets = loadSecrets(env);
  const access = loadAccessPolicy(env.WA_ACCESS_FILE);
  const explicitDir = env.WA_BACKUP_DIR?.trim();
  return {
    secrets,
    access,
    maxResponseChars: intVar(env, "WA_MAX_RESPONSE_CHARS", 1000, DEFAULT_MAX_RESPONSE_CHARS),
    backupDir: explicitDir ? resolve(explicitDir) : defaultBackupDir(env),
    backupRetentionDays: intVar(env, "WA_BACKUP_RETENTION_DAYS", 1, DEFAULT_BACKUP_RETENTION_DAYS),
    enableDelete: boolVar(env, "WA_ENABLE_DELETE"),
  };
}

export { ConfigError } from "./errors.js";
export { AccessPolicy, ACCESS_LEVELS, type AccessLevel } from "./access.js";
