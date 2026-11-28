/**
 * Start the hosted-mode app on an ephemeral port, with a fake World Anvil and
 * a fake fetch for client metadata documents. All values are invented.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HttpConfig } from "../../src/http/config.js";
import { type HttpAppOptions, createHttpApp } from "../../src/http/app.js";
import { DEFAULT_REDIRECT_URIS } from "../../src/oauth/redirects.js";
import { hashPassphrase, parsePassphraseHash } from "../../src/oauth/passphrase.js";
import { createFakeWorldAnvil, seedData } from "./fake-wa.js";
import { testConfig } from "./setup.js";

export const PASSPHRASE = "invented test passphrase 42";
let hashCache: string | undefined;

/** Claude-like metadata document client (invented path on the default allowed host). */
export const CIMD_ID = "https://claude.ai/oauth/fake-test-client-metadata";
export const CIMD_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const LOOPBACK_CIMD_ID = "https://claude.ai/oauth/fake-loopback-client-metadata";

export interface CimdFixture {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

export function cimdDoc(id: string, extra: Record<string, unknown> = {}): CimdFixture {
  return {
    headers: { "content-type": "application/json", "cache-control": "max-age=60" },
    body: JSON.stringify({
      client_id: id,
      client_name: "Invented Test Client",
      redirect_uris: [CIMD_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    }),
  };
}

export function fakeCimdFetch(docs: Record<string, CimdFixture>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const d = docs[url];
    if (!d) return new Response("not found", { status: 404 });
    return new Response(d.body, { status: d.status ?? 200, headers: d.headers ?? {} });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function startHttp(
  o: {
    http?: Partial<HttpConfig>;
    docs?: Record<string, CimdFixture>;
    clientsJson?: unknown;
    oauthDir?: string;
  } & Partial<Omit<HttpAppOptions, "config" | "http" | "passphrase">> = {},
) {
  hashCache ??= await hashPassphrase(PASSPHRASE);
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), "ahm-http-"));
  const oauthDir = o.oauthDir ?? join(root, "oauth");
  const http: HttpConfig = {
    publicUrl: base,
    publicHostname: "127.0.0.1",
    listenHost: "127.0.0.1",
    port,
    passphraseFile: join(root, "unused"),
    oauthDir,
    logDir: join(root, "logs"),
    logRetentionDays: 180,
    cimdHosts: ["claude.ai"],
    redirectUris: [...DEFAULT_REDIRECT_URIS],
    trustedProxies: [],
    ...o.http,
  };
  if (o.clientsJson !== undefined) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, "clients.json"), JSON.stringify(o.clientsJson));
  }
  const fake = createFakeWorldAnvil(seedData());
  const cimd = fakeCimdFetch(
    o.docs ?? {
      [CIMD_ID]: cimdDoc(CIMD_ID),
      [LOOPBACK_CIMD_ID]: cimdDoc(LOOPBACK_CIMD_ID, {
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      }),
    },
  );
  const config = testConfig();
  const { now, grantLimits, attemptLimits, sessions } = o;
  const h = createHttpApp({
    config,
    http,
    passphrase: parsePassphraseHash(hashCache),
    serverDeps: {
      clientOptions: { fetch: fake.fetch, minIntervalMs: 0, backoffBaseMs: 1, backoffMaxMs: 5 },
    },
    cimdFetch: cimd.fetch,
    failureDelayMs: o.failureDelayMs ?? 0,
    now,
    grantLimits,
    attemptLimits,
    sessions,
  });
  server.on("request", h.app);

  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init });
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });

  /** Run /authorize up to the passphrase page; returns the request id. */
  const startAuthorize = async (
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ) => {
    const res = await get(`/authorize?${new URLSearchParams(params).toString()}`, { headers });
    const html = await res.text();
    const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
    return { res, html, id };
  };

  /** Full sign-in: returns tokens for a client. */
  const signIn = async (
    clientId = CIMD_ID,
    redirectUri = CIMD_REDIRECT,
    extra: Record<string, string> = {},
  ) => {
    const p = pkce();
    const a = await startAuthorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: p.challenge,
      code_challenge_method: "S256",
      state: "fake-state-1",
      resource: `${base}/mcp`,
      scope: "mcp offline_access",
      ...extra,
    });
    if (!a.id) throw new Error(`no consent page: ${a.res.status} ${a.html.slice(0, 200)}`);
    const r = await form("/authorize", {
      request_id: a.id,
      passphrase: PASSPHRASE,
      action: "approve",
    });
    const loc = new URL(r.headers.get("location") ?? "");
    const code = loc.searchParams.get("code") ?? "";
    const t = await form("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: p.verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: `${base}/mcp`,
    });
    const tokens = (await t.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    return { tokens, location: loc };
  };

  const mcpClient = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test-http", version: "0" });
    await client.connect(transport);
    return { client, transport };
  };

  return {
    base,
    h,
    http,
    fake,
    cimd,
    config,
    get,
    form,
    startAuthorize,
    signIn,
    mcpClient,
    async close() {
      await h.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
