/**
 * The passphrase that opens the authorization page. The secret file holds a
 * scrypt hash produced by `anvil-hammer-mcp hash-passphrase`; the passphrase
 * itself is never stored. Uses node:crypto only.
 */
import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../config/errors.js";

export const MIN_PASSPHRASE_LENGTH = 12;
/** Longer input is refused before hashing (bounded work per attempt). */
export const MAX_PASSPHRASE_LENGTH = 1024;

const ALGO = "scrypt";
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 96 * 1024 * 1024;

export interface PassphraseHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function derive(passphrase: string, salt: Buffer, o: ScryptOptions, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFC"), salt, len, { ...o, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url> */
export async function hashPassphrase(passphrase: string): Promise<string> {
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH)
    throw new ConfigError(`The passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  if (passphrase.length > MAX_PASSPHRASE_LENGTH)
    throw new ConfigError(`The passphrase must have at most ${MAX_PASSPHRASE_LENGTH} characters.`);
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = DEFAULT_PARAMS;
  const hash = await derive(passphrase, salt, { N, r, p }, KEY_LENGTH);
  return [ALGO, N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function parsePassphraseHash(text: string): PassphraseHash {
  const parts = text.trim().split("$");
  const bad = () =>
    new ConfigError(
      "WA_PASSPHRASE_FILE must hold a hash produced by `anvil-hammer-mcp hash-passphrase`, " +
        "not the passphrase itself.",
    );
  if (parts.length !== 6 || parts[0] !== ALGO) throw bad();
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const hash = Buffer.from(parts[5] ?? "", "base64url");
  const pow2 = Number.isInteger(N) && N >= 16384 && (N & (N - 1)) === 0;
  if (!pow2 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 4)
    throw bad();
  if (128 * N * r > MAX_MEMORY / 1.5 || salt.length < 16 || hash.length < 32) throw bad();
  return { N, r, p, salt, hash };
}

export async function verifyPassphrase(h: PassphraseHash, candidate: string): Promise<boolean> {
  if (!candidate || candidate.length > MAX_PASSPHRASE_LENGTH) return false;
  const key = await derive(candidate, h.salt, { N: h.N, r: h.r, p: h.p }, h.hash.length);
  return timingSafeEqual(key, h.hash);
}
