import { readFileSync } from "node:fs";

/**
 * Fixed values. The API base URL is deliberately a constant: it cannot be
 * changed by configuration or environment (CLAUDE.md, principle 2).
 */
export const WORLD_ANVIL_BASE_URL = "https://www.worldanvil.com/api/external/boromir" as const;

export const SERVER_NAME = "anvil-hammer-mcp";
/** The version has one source: package.json (one level above src/ and dist/). */
export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
export const REPO_URL = "https://github.com/barrator/anvil-hammer-mcp";
export const USER_AGENT = `${SERVER_NAME} (${REPO_URL}, ${SERVER_VERSION})`;

/** World Anvil list endpoints return at most 50 items per page. */
export const PAGE_SIZE = 50;

export const DEFAULT_MAX_RESPONSE_CHARS = 25_000;
