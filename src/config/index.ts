import { DEFAULT_MAX_RESPONSE_CHARS } from "../constants.js";
import { type AccessPolicy, loadAccessPolicy } from "./access.js";
import { ConfigError } from "./errors.js";
import { loadSecrets, type Secrets } from "./secrets.js";

export interface Config {
  secrets: Secrets;
  access: AccessPolicy;
  maxResponseChars: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const secrets = loadSecrets(env);
  const access = loadAccessPolicy(env.WA_ACCESS_FILE);

  let maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS;
  const raw = env.WA_MAX_RESPONSE_CHARS?.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1000) {
      throw new ConfigError("WA_MAX_RESPONSE_CHARS must be an integer of at least 1000.");
    }
    maxResponseChars = n;
  }
  return { secrets, access, maxResponseChars };
}

export { ConfigError } from "./errors.js";
export { AccessPolicy, ACCESS_LEVELS, type AccessLevel } from "./access.js";
