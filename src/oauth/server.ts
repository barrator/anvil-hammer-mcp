/**
 * The built-in authorization server: discovery documents, /authorize (ours),
 * /token and /revoke (the SDK's handlers on top of our provider), and the
 * bearer check for protected routes. Single user, public clients only, no
 * dynamic client registration.
 */
import { type Request, type Response, type RequestHandler, Router } from "express";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type AuthEvent, authorizeRouter } from "./authorize.js";
import type { ClientRegistry } from "./clients.js";
import { type GrantStore, MCP_SCOPE } from "./grants.js";
import {
  type AttemptLimits,
  AttemptLimiter,
  DEFAULT_ATTEMPT_LIMITS,
  RateLimiter,
} from "./limits.js";
import {
  AS_METADATA_PATH,
  type OAuthUrls,
  PRM_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
  sameResource,
} from "./metadata.js";
import type { PassphraseHash } from "./passphrase.js";

/** Normalize a requested resource to ours (the code and grants store the canonical form). */
function canonical(resource: URL | undefined, urls: OAuthUrls): string | undefined {
  if (!resource) return undefined;
  return sameResource(resource.href, urls.mcp) ? urls.mcp : resource.href;
}

export class AnvilOAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly clients: ClientRegistry,
    private readonly grants: GrantStore,
    private readonly urls: OAuthUrls,
  ) {}

  get clientsStore(): ClientRegistry {
    return this.clients;
  }

  authorize(): Promise<void> {
    // Our own /authorize router handles this (passphrase page, iss parameter).
    return Promise.reject(new Error("Not used: see authorize.ts."));
  }

  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return Promise.resolve(this.grants.challengeFor(client.client_id, code));
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return Promise.resolve(
      this.grants.exchangeCode(client.client_id, code, redirectUri, canonical(resource, this.urls)),
    );
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return Promise.resolve(
      this.grants.refresh(client.client_id, refreshToken, scopes, canonical(resource, this.urls)),
    );
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return Promise.resolve(this.grants.verifyAccess(token));
  }

  revokeToken(client: OAuthClientInformationFull, r: OAuthTokenRevocationRequest): Promise<void> {
    this.grants.revoke(client.client_id, r.token);
    return Promise.resolve();
  }
}

export interface OAuthServerOptions {
  urls: OAuthUrls;
  clients: ClientRegistry;
  grants: GrantStore;
  passphrase: PassphraseHash;
  allowedRedirects: readonly string[];
  log: (
    e:
      | AuthEvent
      | { kind: "token_request" | "revoke_request"; ip?: string; status: number; grant?: string },
  ) => void;
  now?: () => number;
  failureDelayMs?: number;
  attemptLimits?: AttemptLimits;
  /** Authorization requests per address per minute. */
  authorizeRequestsPerMinute?: number;
}

export interface OAuthServer {
  router: Router;
  /** Bearer check for protected routes: 401 + WWW-Authenticate with resource_metadata and scope. */
  requireToken: RequestHandler;
  provider: AnvilOAuthProvider;
}

function json(res: Response, body: unknown): void {
  res.set({ "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" });
  res.json(body);
}

export function createOAuthServer(o: OAuthServerOptions): OAuthServer {
  const provider = new AnvilOAuthProvider(o.clients, o.grants, o.urls);
  const router = Router();
  const prm = protectedResourceMetadata(o.urls);
  const asMeta = authorizationServerMetadata(o.urls, { cimd: o.clients.cimdEnabled });

  // RFC 9728: at the path of the MCP endpoint, and at the root.
  router.get(`${PRM_PATH}/mcp`, (_req, res) => json(res, prm));
  router.get(PRM_PATH, (_req, res) => json(res, prm));
  router.get(AS_METADATA_PATH, (_req, res) => json(res, asMeta));

  router.use(
    "/authorize",
    authorizeRouter({
      urls: o.urls,
      clients: o.clients,
      grants: o.grants,
      passphrase: o.passphrase,
      allowedRedirects: o.allowedRedirects,
      attempts: new AttemptLimiter(o.attemptLimits ?? DEFAULT_ATTEMPT_LIMITS, o.now),
      requests: new RateLimiter(
        { max: o.authorizeRequestsPerMinute ?? 30, windowMs: 60_000 },
        o.now,
      ),
      log: o.log,
      now: o.now,
      failureDelayMs: o.failureDelayMs,
    }),
  );

  const audit =
    (kind: "token_request" | "revoke_request") =>
    (req: Request, res: Response, next: () => void) => {
      res.on("finish", () => {
        const grant = (req.body as Record<string, unknown> | undefined)?.grant_type;
        o.log({
          kind,
          ip: req.ip,
          status: res.statusCode,
          ...(typeof grant === "string" ? { grant } : {}),
        });
      });
      next();
    };
  router.use("/token", audit("token_request"), tokenHandler({ provider }));
  router.use("/revoke", audit("revoke_request"), revocationHandler({ provider }));

  const requireToken = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: o.urls.resourceMetadata,
    expectedResource: new URL(o.urls.mcp),
  });

  return { router, requireToken, provider };
}
