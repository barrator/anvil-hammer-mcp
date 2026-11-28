/**
 * Discovery documents: OAuth 2.0 Protected Resource Metadata (RFC 9728) for
 * the MCP endpoint and Authorization Server Metadata (RFC 8414).
 */
import { MCP_SCOPE, OFFLINE_SCOPE } from "./grants.js";

export interface OAuthUrls {
  /** Issuer identifier, also the public origin: https://host (no trailing slash). */
  issuer: string;
  /** Canonical MCP resource: <issuer>/mcp. */
  mcp: string;
  /** Protected resource metadata URL for the MCP resource. */
  resourceMetadata: string;
  authorize: string;
  token: string;
  revoke: string;
}

export const PRM_PATH = "/.well-known/oauth-protected-resource";
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

export function oauthUrls(issuer: string): OAuthUrls {
  return {
    issuer,
    mcp: `${issuer}/mcp`,
    resourceMetadata: `${issuer}${PRM_PATH}/mcp`,
    authorize: `${issuer}/authorize`,
    token: `${issuer}/token`,
    revoke: `${issuer}/revoke`,
  };
}

export function protectedResourceMetadata(u: OAuthUrls) {
  return {
    resource: u.mcp,
    authorization_servers: [u.issuer],
    // offline_access is not a resource requirement (MCP spec): only in the AS metadata.
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "anvil-hammer-mcp",
  };
}

export function authorizationServerMetadata(u: OAuthUrls, o: { cimd: boolean }) {
  return {
    issuer: u.issuer,
    authorization_endpoint: u.authorize,
    token_endpoint: u.token,
    revocation_endpoint: u.revoke,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients only; with CIMD, Claude needs "none" here.
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE, OFFLINE_SCOPE],
    authorization_response_iss_parameter_supported: true,
    ...(o.cimd ? { client_id_metadata_document_supported: true } : {}),
  };
}

/** Compare a requested resource with ours: fragment and one trailing slash aside, case of scheme/host aside. */
export function sameResource(requested: string, canonical: string): boolean {
  try {
    const a = new URL(requested);
    if (a.hash || a.search) return false;
    const norm = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
    return norm(a) === norm(new URL(canonical));
  } catch {
    return false;
  }
}
