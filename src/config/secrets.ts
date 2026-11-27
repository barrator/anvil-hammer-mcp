import { readFileSync } from "node:fs";
import { ConfigError } from "./errors.js";

export interface Secrets {
  appKey: string;
  authToken: string;
}

type Env = Record<string, string | undefined>;

function readSecret(env: Env, fileVar: string, valueVar: string): string {
  const file = env[fileVar]?.trim();
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      // Never echo file content; the path itself is not secret.
      throw new ConfigError(`${fileVar} points to a file that cannot be read: ${file}`);
    }
    const value = raw.trim();
    if (!value) throw new ConfigError(`${fileVar} points to an empty file: ${file}`);
    return value;
  }
  const value = env[valueVar]?.trim();
  if (value) return value;
  throw new ConfigError(
    `Missing World Anvil credential: set ${fileVar} (recommended) or ${valueVar}.`,
  );
}

/**
 * Keys come from files (WA_APP_KEY_FILE, WA_AUTH_TOKEN_FILE). For local stdio
 * use, WA_APP_KEY / WA_AUTH_TOKEN are accepted as a less safe fallback.
 * A file variable, when set, always wins over the plain variable.
 */
export function loadSecrets(env: Env): Secrets {
  const appKey = readSecret(env, "WA_APP_KEY_FILE", "WA_APP_KEY");
  const authToken = readSecret(env, "WA_AUTH_TOKEN_FILE", "WA_AUTH_TOKEN");
  for (const [name, v] of [
    ["application key", appKey],
    ["auth token", authToken],
  ] as const) {
    if (v.length < 8) throw new ConfigError(`The World Anvil ${name} looks too short to be valid.`);
    if (/\s/.test(v)) throw new ConfigError(`The World Anvil ${name} contains whitespace.`);
  }
  return { appKey, authToken };
}
