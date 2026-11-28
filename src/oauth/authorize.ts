/**
 * The authorization endpoint (GET shows the passphrase page, POST checks it).
 * Written here rather than taken from the SDK: the SDK handler does not add
 * the RFC 9207 `iss` parameter to its responses, and it knows nothing of CIMD.
 *
 * Order: client → redirect URI (errors before this point are shown on a page,
 * never redirected) → response type, PKCE, resource, scope (errors redirected
 * with `iss`) → passphrase page → code redirected with `state` and `iss`.
 */
import { randomBytes } from "node:crypto";
import express, { type Request, type Response, Router } from "express";
import type { ClientRegistry, ClientSource } from "./clients.js";
import { type GrantStore, MCP_SCOPE, OFFLINE_SCOPE } from "./grants.js";
import type { AttemptLimiter, RateLimiter } from "./limits.js";
import { type OAuthUrls, sameResource } from "./metadata.js";
import { consentPage, errorPage, pageCsp } from "./page.js";
import { type PassphraseHash, verifyPassphrase } from "./passphrase.js";
import { isAllowedRedirectForm, isLoopbackUri, matchesAny, redirectHost } from "./redirects.js";

export type AuthEvent = {
  kind:
    | "client_refused"
    | "authorization_request"
    | "login_ok"
    | "login_failed"
    | "login_blocked"
    | "consent_denied";
  ip?: string;
  client?: string;
  reason?: string;
};

export interface AuthorizeDeps {
  urls: OAuthUrls;
  clients: ClientRegistry;
  grants: GrantStore;
  passphrase: PassphraseHash;
  /** Redirect URIs accepted from metadata-document clients (Claude's by default). */
  allowedRedirects: readonly string[];
  attempts: AttemptLimiter;
  requests: RateLimiter;
  log: (e: AuthEvent) => void;
  now?: () => number;
  /** Pause after a wrong passphrase (ms). */
  failureDelayMs?: number;
}

interface Pending {
  clientId: string;
  clientName: string;
  source: ClientSource;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const ALLOWED_SCOPES = new Set([MCP_SCOPE, OFFLINE_SCOPE]);

function setPageHeaders(res: Response, redirectOrigin?: string): void {
  res.set({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Content-Security-Policy": pageCsp(redirectOrigin),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Type": "text/html; charset=utf-8",
  });
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

export function authorizeRouter(d: AuthorizeDeps): Router {
  const router = Router();
  const pending = new Map<string, Pending>();
  const now = () => (d.now ?? Date.now)();

  const prune = () => {
    for (const [id, p] of pending) if (p.expiresAt < now()) pending.delete(id);
    while (pending.size >= MAX_PENDING) {
      const first = pending.keys().next().value;
      if (first === undefined) break;
      pending.delete(first);
    }
  };

  const page = (res: Response, status: number, title: string, message: string) => {
    setPageHeaders(res);
    res.status(status).send(errorPage(title, message));
  };

  router.get("/", async (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    if (!d.requests.take(ip))
      return page(
        res,
        429,
        "Too many requests",
        "Too many authorization requests. Try again later.",
      );

    const q = req.query as Record<string, unknown>;
    const one = (name: string): string | undefined | null => {
      const v = q[name];
      if (v === undefined) return undefined;
      return typeof v === "string" ? v : null; // null: repeated or structured parameter
    };
    for (const name of Object.keys(q))
      if (one(name) === null)
        return page(res, 400, "Invalid request", `The parameter "${name}" must appear once.`);

    const clientId = one("client_id");
    if (!clientId) return page(res, 400, "Invalid request", "client_id is missing.");
    const found = await d.clients.lookup(clientId);
    if (!found.ok) {
      d.log({ kind: "client_refused", ip, client: clientId, reason: found.reason });
      return page(res, 400, "Client not accepted", found.message);
    }
    const { client, source } = found;

    const requested =
      one("redirect_uri") ??
      (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!requested)
      return page(res, 400, "Invalid request", "redirect_uri is required for this client.");
    const registered =
      isAllowedRedirectForm(requested) &&
      matchesAny(requested, client.redirect_uris) &&
      (source !== "cimd" || matchesAny(requested, d.allowedRedirects));
    if (!registered) {
      d.log({ kind: "client_refused", ip, client: clientId, reason: "redirect_uri" });
      return page(
        res,
        400,
        "Invalid redirect",
        "This redirect address is not registered for this client on this server.",
      );
    }

    // From here on, errors go back to the client, with state and iss.
    const state = one("state") ?? undefined;
    const fail = (error: string, description: string) =>
      res.redirect(
        302,
        withParams(requested, { error, error_description: description, state, iss: d.urls.issuer }),
      );

    if (one("response_type") !== "code")
      return fail("unsupported_response_type", 'Only response_type "code" is supported.');
    const challenge = one("code_challenge");
    if (!challenge) return fail("invalid_request", "code_challenge is required (PKCE).");
    if (one("code_challenge_method") !== "S256")
      return fail("invalid_request", "code_challenge_method must be S256.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
      return fail("invalid_request", "code_challenge is not a valid S256 challenge.");
    const resource = one("resource");
    if (resource && !sameResource(resource, d.urls.mcp))
      return fail("invalid_target", "This server only issues tokens for its own MCP endpoint.");
    const asked = (one("scope") ?? "").split(" ").filter(Boolean);
    const unknown = asked.filter((s) => !ALLOWED_SCOPES.has(s));
    if (unknown.length) return fail("invalid_scope", `Unknown scope: ${unknown.join(" ")}.`);
    const scopes = [...new Set([MCP_SCOPE, ...asked])];

    prune();
    const requestId = randomBytes(24).toString("base64url");
    const p: Pending = {
      clientId,
      clientName: client.client_name ?? clientId,
      source,
      redirectUri: requested,
      state,
      codeChallenge: challenge,
      scopes,
      expiresAt: now() + PENDING_TTL_MS,
    };
    pending.set(requestId, p);
    d.log({ kind: "authorization_request", ip, client: clientId });
    setPageHeaders(res, new URL(requested).origin);
    res.status(200).send(view(requestId, p));
  });

  const view = (requestId: string, p: Pending, error?: string) =>
    consentPage({
      requestId,
      clientName: p.clientName,
      source: p.source,
      clientId: p.clientId,
      redirectHost: redirectHost(p.redirectUri),
      loopback: isLoopbackUri(p.redirectUri),
      error,
    });

  router.post(
    "/",
    express.urlencoded({ extended: false, limit: "4kb" }),
    async (req: Request, res: Response) => {
      const ip = req.ip ?? "unknown";
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      const p = pending.get(requestId);
      if (!p || p.expiresAt < now()) {
        if (p) pending.delete(requestId);
        return page(
          res,
          400,
          "Sign-in expired",
          "This sign-in page has expired. Start the connection again from your application.",
        );
      }
      const origin = new URL(p.redirectUri).origin;

      if (body.action === "deny") {
        pending.delete(requestId);
        d.log({ kind: "consent_denied", ip, client: p.clientId });
        return res.redirect(
          302,
          withParams(p.redirectUri, {
            error: "access_denied",
            error_description: "The owner denied the request.",
            state: p.state,
            iss: d.urls.issuer,
          }),
        );
      }

      const wait = d.attempts.blockedFor(ip);
      if (wait > 0) {
        d.log({ kind: "login_blocked", ip, client: p.clientId });
        setPageHeaders(res, origin);
        res.set("Retry-After", String(wait));
        return res
          .status(429)
          .send(
            view(
              requestId,
              p,
              `Too many wrong attempts. Try again in about ${Math.ceil(wait / 60)} minute(s).`,
            ),
          );
      }

      const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
      if (!(await verifyPassphrase(d.passphrase, passphrase))) {
        d.attempts.fail(ip);
        d.log({ kind: "login_failed", ip, client: p.clientId });
        await new Promise((r) => setTimeout(r, d.failureDelayMs ?? 1000));
        setPageHeaders(res, origin);
        return res.status(403).send(view(requestId, p, "Wrong passphrase."));
      }

      d.attempts.succeed(ip);
      pending.delete(requestId);
      const code = d.grants.createCode({
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge,
        resource: d.urls.mcp,
        scopes: p.scopes,
      });
      d.log({ kind: "login_ok", ip, client: p.clientId });
      res.set("Cache-Control", "no-store");
      res.redirect(302, withParams(p.redirectUri, { code, state: p.state, iss: d.urls.issuer }));
    },
  );

  return router;
}
