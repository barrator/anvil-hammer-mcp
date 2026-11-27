/**
 * Fixed values. The API base URL is deliberately a constant: it cannot be
 * changed by configuration or environment (CLAUDE.md, principle 2).
 */
export const WORLD_ANVIL_BASE_URL = "https://www.worldanvil.com/api/external/boromir" as const;

export const SERVER_NAME = "anvil-hammer-mcp";
export const SERVER_VERSION = "0.1.0";
export const REPO_URL = "https://github.com/barrator/anvil-hammer-mcp";
export const USER_AGENT = `${SERVER_NAME} (${REPO_URL}, ${SERVER_VERSION})`;

/** World Anvil list endpoints return at most 50 items per page. */
export const PAGE_SIZE = 50;

export const DEFAULT_MAX_RESPONSE_CHARS = 25_000;
