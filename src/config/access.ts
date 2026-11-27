import { existsSync, readFileSync } from "node:fs";
import { ConfigError } from "./errors.js";

export const ACCESS_LEVELS = ["full_edit", "edit_only", "read_only", "blocked"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Level of any world not listed in the access file. */
export const DEFAULT_ACCESS_LEVEL: AccessLevel = "read_only";

export class AccessPolicy {
  constructor(private readonly levels: ReadonlyMap<string, AccessLevel> = new Map()) {}

  levelFor(worldId: string): AccessLevel {
    return this.levels.get(worldId) ?? DEFAULT_ACCESS_LEVEL;
  }

  canRead(worldId: string): boolean {
    return this.levelFor(worldId) !== "blocked";
  }

  get size(): number {
    return this.levels.size;
  }
}

/**
 * Collect the keys of the top-level JSON object, in order, including duplicates.
 * JSON.parse silently keeps the last duplicate, so duplicates are detected here.
 * Assumes `text` already parsed successfully as a JSON object.
 */
export function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      // Read a full string literal.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const literal = text.slice(i, j + 1);
      if (depth === 1) {
        // A string at depth 1 followed by ':' is a key.
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k] as string)) k++;
        if (text[k] === ":") keys.push(JSON.parse(literal) as string);
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

/** Parse and validate the access file content. Throws ConfigError on any problem. */
export function parseAccessConfig(text: string, source = "access file"): AccessPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must be a JSON object mapping world IDs to access levels.`);
  }

  const seen = new Set<string>();
  for (const key of topLevelKeys(text)) {
    if (seen.has(key)) throw new ConfigError(`${source} lists world "${key}" more than once.`);
    seen.add(key);
  }

  const levels = new Map<string, AccessLevel>();
  for (const [worldId, level] of Object.entries(parsed)) {
    if (!worldId.trim()) throw new ConfigError(`${source} contains an empty world ID.`);
    if (!ACCESS_LEVELS.includes(level as AccessLevel)) {
      throw new ConfigError(
        `${source}: world "${worldId}" has unknown level ${JSON.stringify(level)}. ` +
          `Allowed: ${ACCESS_LEVELS.join(", ")}.`,
      );
    }
    levels.set(worldId, level as AccessLevel);
  }
  return new AccessPolicy(levels);
}

/** Load WA_ACCESS_FILE. Not set: every world is read_only. Set but missing: startup fails. */
export function loadAccessPolicy(path: string | undefined): AccessPolicy {
  const p = path?.trim();
  if (!p) return new AccessPolicy();
  if (!existsSync(p)) throw new ConfigError(`WA_ACCESS_FILE points to a missing file: ${p}`);
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    throw new ConfigError(`WA_ACCESS_FILE cannot be read: ${p}`);
  }
  return parseAccessConfig(text, `Access file ${p}`);
}
