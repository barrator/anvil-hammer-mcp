/**
 * Redirect URI rules. Pure, no network.
 *
 * - A redirect URI is https, or http on a loopback host (MCP authorization
 *   spec: "All redirect URIs MUST be either localhost or use HTTPS"). No fragment.
 * - A requested URI matches a registered one exactly, except for loopback
 *   URIs, where the port is ignored (RFC 8252 section 7.3; Claude Code uses an
 *   ephemeral port with http://localhost/callback and http://127.0.0.1/callback).
 */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

export function isLoopbackUri(uri: string): boolean {
  const u = parse(uri);
  return !!u && u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/** Acceptable form for a registered or requested redirect URI. */
export function isAllowedRedirectForm(uri: string): boolean {
  const u = parse(uri);
  if (!u || u.hash || uri.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

export function redirectMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  const req = parse(requested);
  const reg = parse(registered);
  if (!req || !reg) return false;
  if (req.protocol !== "http:" || reg.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(req.hostname) || req.hostname !== reg.hostname) return false;
  // Loopback: only the port may differ.
  return req.pathname === reg.pathname && req.search === reg.search && !req.hash && !reg.hash;
}

export function matchesAny(requested: string, registered: readonly string[]): boolean {
  return registered.some((r) => redirectMatches(requested, r));
}

/** What the consent page shows: the host the browser will be sent to. */
export function redirectHost(uri: string): string {
  return parse(uri)?.hostname ?? uri;
}

/** Claude's redirect URIs: the hosted apps' callback and Claude Code's loopback redirects. */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "http://localhost/callback",
  "http://127.0.0.1/callback",
] as const;
