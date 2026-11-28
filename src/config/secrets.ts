import { readFileSync, statSync } from "node:fs";
import { ConfigError } from "./errors.js";

export interface Secrets {
  appKey: string;
  authToken: string;
}

type Env = Record<string, string | undefined>;

export interface SecretOptions {
  /** Hosted mode: keys must come from files, never from plain variables. */
  filesOnly?: boolean;
}

/**
 * Read a secret file after checking it: it must exist, be a regular file, be
 * non-empty, and give no permission to "others" (not world-readable or
 * world-writable). The error names the variable and the path, never the content.
 */
export function readSecretFile(fileVar: string, file: string): string {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new ConfigError(`${fileVar} points to a file that does not exist: ${file}`);
  }
  if (!st.isFile()) throw new ConfigError(`${fileVar} must point to a regular file: ${file}`);
  if (st.mode & 0o006) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
    throw new ConfigError(
      `${fileVar} is readable or writable by other users (mode ${mode}): ${file}. ` +
        "Restrict it, for example with chmod 600 (or 400).",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`${fileVar} points to a file that cannot be read: ${file}`);
  }
  const value = raw.trim();
  if (!value) throw new ConfigError(`${fileVar} points to an empty file: ${file}`);
  return value;
}

function readSecret(env: Env, fileVar: string, valueVar: string, o: SecretOptions): string {
  const file = env[fileVar]?.trim();
  if (file) return readSecretFile(fileVar, file);
  if (o.filesOnly) {
    throw new ConfigError(
      `Missing World Anvil credential: set ${fileVar}. In hosted mode keys are read from files only` +
        (env[valueVar] ? ` (${valueVar} is ignored).` : "."),
    );
  }
  const value = env[valueVar]?.trim();
  if (value) return value;
  throw new ConfigError(
    `Missing World Anvil credential: set ${fileVar} (recommended) or ${valueVar}.`,
  );
}

/**
 * Keys come from files (WA_APP_KEY_FILE, WA_AUTH_TOKEN_FILE). For local stdio
 * use, WA_APP_KEY / WA_AUTH_TOKEN are accepted as a less safe fallback; hosted
 * mode refuses them. A file variable, when set, always wins over the plain variable.
 */
export function loadSecrets(env: Env, o: SecretOptions = {}): Secrets {
  const appKey = readSecret(env, "WA_APP_KEY_FILE", "WA_APP_KEY", o);
  const authToken = readSecret(env, "WA_AUTH_TOKEN_FILE", "WA_AUTH_TOKEN", o);
  for (const [name, v] of [
    ["application key", appKey],
    ["auth token", authToken],
  ] as const) {
    if (v.length < 8) throw new ConfigError(`The World Anvil ${name} looks too short to be valid.`);
    if (/\s/.test(v)) throw new ConfigError(`The World Anvil ${name} contains whitespace.`);
  }
  return { appKey, authToken };
}
