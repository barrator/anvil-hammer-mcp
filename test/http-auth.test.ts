/**
 * Hosted mode, end to end over real HTTP on an ephemeral port: discovery,
 * authorization (passphrase, PKCE, iss), tokens, the MCP endpoint, health.
 * Offline: World Anvil and client metadata documents are fakes.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_APP_KEY, FAKE_TOKEN } from "./helpers/fake-wa.js";
import {
  CIMD_ID,
  CIMD_REDIRECT,
  LOOPBACK_CIMD_ID,
  PASSPHRASE,
  pkce,
  startHttp,
} from "./helpers/http.js";

type Started = Awaited<ReturnType<typeof startHttp>>;
const open: Started[] = [];
const start = async (o: Parameters<typeof startHttp>[0] = {}) => {
  const s = await startHttp(o);
  open.push(s);
  return s;
};
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

const authParams = (s: Started, challenge: string, extra: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: CIMD_ID,
  redirect_uri: CIMD_REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "fake-state-xyz",
  resource: `${s.base}/mcp`,
  ...extra,
});

function logLines(s: Started): Record<string, unknown>[] {
  const files = readdirSync(s.http.logDir).filter((f) => f.endsWith(".jsonl"));
  return files.flatMap((f) =>
    readFileSync(join(s.http.logDir, f), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

describe("discovery", () => {
  it("serves protected resource metadata whose resource is the exact MCP URL", async () => {
    const s = await start();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const prm = (await (await s.get(path)).json()) as Record<string, unknown>;
      expect(prm.resource).toBe(`${s.base}/mcp`);
      expect(prm.authorization_servers).toEqual([s.base]);
      expect(prm.scopes_supported).toEqual(["mcp"]); // no offline_access in PRM
    }
  });

  it("serves RFC 8414 metadata with S256, none, iss, CIMD and no registration endpoint", async () => {
    const s = await start();
    const m = (await (await s.get("/.well-known/oauth-authorization-server")).json()) as Record<
      string,
      unknown
    >;
    expect(m.issuer).toBe(s.base);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.scopes_supported).toEqual(["mcp", "offline_access"]);
    expect(m).not.toHaveProperty("registration_endpoint");
    expect(m.revocation_endpoint).toBe(`${s.base}/revoke`);
    expect((await s.get("/register", { method: "POST" })).status).toBe(404);
  });

  it("does not advertise CIMD when no host is allowed", async () => {
    const s = await start({ http: { cimdHosts: [] } });
    const m = (await (await s.get("/.well-known/oauth-authorization-server")).json()) as Record<
      string,
      unknown
    >;
    expect(m).not.toHaveProperty("client_id_metadata_document_supported");
  });
});

describe("the MCP endpoint without a valid token", () => {
  it("answers 401 with resource_metadata and scope, before any tool runs", async () => {
    const s = await start();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wa_list_worlds", arguments: {} },
    });
    const variants: Record<string, string>[] = [
      {},
      { Authorization: "Bearer at_not-a-real-token" },
      { Authorization: "Basic Zm9vOmJhcg==" },
    ];
    for (const headers of variants) {
      const r = await s.get("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body,
      });
      expect(r.status).toBe(401);
      const www = r.headers.get("www-authenticate") ?? "";
      expect(www).toContain(
        `resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(www).toContain('scope="mcp"');
    }
    expect(s.fake.calls).toHaveLength(0);
  });

  it("refuses an expired access token with 401", async () => {
    let t = Date.parse("2026-11-01T10:00:00Z");
    const s = await start({ now: () => t });
    const { tokens } = await s.signIn();
    t += 31 * 60_000;
    const r = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(r.status).toBe(401);
  });

  it("refuses a token in the query string", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const r = await s.get(`/healthz/worldanvil?access_token=${tokens.access_token}`);
    expect(r.status).toBe(401);
  });

  it("refuses another Host or a foreign Origin", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(
        `${s.base}/mcp`,
        { method: "POST", headers: { ...auth, host: "evil.example" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(403);
    const r = await s.get("/mcp", {
      method: "POST",
      headers: { ...auth, origin: "https://evil.example" },
    });
    expect(r.status).toBe(403);
  });
});

describe("authorization", () => {
  it("shows the client name and the redirect host, then redirects with code, state and iss", async () => {
    const s = await start();
    const p = pkce();
    const a = await s.startAuthorize(authParams(s, p.challenge));
    expect(a.res.status).toBe(200);
    expect(a.html).toContain("Invented Test Client");
    expect(a.html).toContain('<p class="host">claude.ai</p>');
    expect(a.html).not.toContain("Local application");
    const csp = a.res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
    const r = await s.form("/authorize", {
      request_id: a.id!,
      passphrase: PASSPHRASE,
      action: "approve",
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CIMD_REDIRECT);
    expect(loc.searchParams.get("code")).toMatch(/^ac_/);
    expect(loc.searchParams.get("state")).toBe("fake-state-xyz");
    expect(loc.searchParams.get("iss")).toBe(s.base);
  });

  it("warns for a loopback redirect and ignores its port", async () => {
    const s = await start();
    const p = pkce();
    const a = await s.startAuthorize(
      authParams(s, p.challenge, {
        client_id: LOOPBACK_CIMD_ID,
        redirect_uri: "http://localhost:43117/callback",
      }),
    );
    expect(a.res.status).toBe(200);
    expect(a.html).toContain("Local application");
    expect(a.html).toContain('<p class="host">localhost</p>');
  });

  it("refuses unknown clients and unregistered redirects on a page, never by redirect", async () => {
    const s = await start();
    const p = pkce();
    const cases: Record<string, string>[] = [
      { client_id: "unknown-client-0001" },
      { client_id: "https://evil.example/client.json" },
      { client_id: "http://claude.ai/oauth/fake-test-client-metadata" },
      { redirect_uri: "https://evil.example/callback" },
      { redirect_uri: "http://localhost:5555/callback" }, // not in this client's document
    ];
    for (const c of cases) {
      const a = await s.startAuthorize(authParams(s, p.challenge, c));
      expect(a.res.status).toBe(400);
      expect(a.res.headers.get("location")).toBeNull();
      expect(a.id).toBeUndefined();
    }
  });

  it("refuses a metadata-document redirect that is not in the allowed list", async () => {
    const s = await start({ http: { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] } });
    const a = await s.startAuthorize(
      authParams(s, pkce().challenge, {
        client_id: LOOPBACK_CIMD_ID,
        redirect_uri: "http://localhost:43117/callback",
      }),
    );
    expect(a.res.status).toBe(400);
  });

  it("redirects protocol errors with error, state and iss", async () => {
    const s = await start();
    const p = pkce();
    const cases: [Record<string, string>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
      [{ scope: "admin" }, "invalid_scope"],
    ];
    for (const [extra, error] of cases) {
      const params = authParams(s, p.challenge, extra);
      if (extra.code_challenge === "") delete (params as Record<string, string>).code_challenge;
      const a = await s.startAuthorize(params);
      expect(a.res.status).toBe(302);
      const loc = new URL(a.res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("state")).toBe("fake-state-xyz");
      expect(loc.searchParams.get("iss")).toBe(s.base);
    }
  });

  it("refuses a wrong passphrase, limits attempts and logs failures without the passphrase", async () => {
    const s = await start();
    const a = await s.startAuthorize(authParams(s, pkce().challenge));
    for (let i = 0; i < 5; i++) {
      const r = await s.form("/authorize", {
        request_id: a.id!,
        passphrase: `wrong guess ${i}`,
        action: "approve",
      });
      expect(r.status).toBe(403);
      expect(await r.text()).toContain("Wrong passphrase.");
    }
    // Sixth try, even with the right passphrase: blocked.
    const blocked = await s.form("/authorize", {
      request_id: a.id!,
      passphrase: PASSPHRASE,
      action: "approve",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    const lines = logLines(s);
    expect(lines.filter((l) => l.kind === "login_failed")).toHaveLength(5);
    expect(lines.some((l) => l.kind === "login_blocked")).toBe(true);
    const raw = readdirSync(s.http.logDir)
      .map((f) => readFileSync(join(s.http.logDir, f), "utf8"))
      .join("");
    expect(raw).not.toContain("wrong guess");
    expect(raw).not.toContain(PASSPHRASE);
  });

  it("applies a global limit across addresses", async () => {
    const s = await start({
      http: { trustedProxies: ["127.0.0.1"] },
      attemptLimits: { perIp: { max: 5, windowMs: 60_000 }, global: { max: 3, windowMs: 60_000 } },
    });
    const a = await s.startAuthorize(authParams(s, pkce().challenge));
    for (let i = 0; i < 3; i++)
      await s.form(
        "/authorize",
        { request_id: a.id!, passphrase: "nope nope", action: "approve" },
        { "x-forwarded-for": `198.51.100.${i + 1}` },
      );
    const r = await s.form(
      "/authorize",
      { request_id: a.id!, passphrase: PASSPHRASE, action: "approve" },
      { "x-forwarded-for": "198.51.100.77" },
    );
    expect(r.status).toBe(429);
  });

  it("denies on request, with access_denied", async () => {
    const s = await start();
    const a = await s.startAuthorize(authParams(s, pkce().challenge));
    const r = await s.form("/authorize", { request_id: a.id!, action: "deny" });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an unknown or reused request id", async () => {
    const s = await start();
    const a = await s.startAuthorize(authParams(s, pkce().challenge));
    expect(
      (await s.form("/authorize", { request_id: "made-up", passphrase: PASSPHRASE })).status,
    ).toBe(400);
    await s.form("/authorize", { request_id: a.id!, passphrase: PASSPHRASE, action: "approve" });
    expect(
      (await s.form("/authorize", { request_id: a.id!, passphrase: PASSPHRASE, action: "approve" }))
        .status,
    ).toBe(400);
  });
});

describe("X-Forwarded-For", () => {
  const lastIp = (s: Started) =>
    logLines(s)
      .filter((l) => l.kind === "authorization_request")
      .at(-1)?.ip;

  it("is ignored when the connection does not come from the gateway", async () => {
    const s = await start({ http: { trustedProxies: ["10.213.70.2"] } });
    await s.startAuthorize(authParams(s, pkce().challenge), { "x-forwarded-for": "203.0.113.66" });
    expect(lastIp(s)).toBe("127.0.0.1");
  });

  it("gives the client address when the connection comes from the gateway", async () => {
    const s = await start({ http: { trustedProxies: ["127.0.0.1"] } });
    await s.startAuthorize(authParams(s, pkce().challenge), { "x-forwarded-for": "203.0.113.66" });
    expect(lastIp(s)).toBe("203.0.113.66");
  });
});

describe("tokens", () => {
  it("exchanges the code once, with the right PKCE verifier, as form-urlencoded", async () => {
    const s = await start();
    const p = pkce();
    const a = await s.startAuthorize(authParams(s, p.challenge));
    const r = await s.form("/authorize", {
      request_id: a.id!,
      passphrase: PASSPHRASE,
      action: "approve",
    });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const body = {
      grant_type: "authorization_code",
      code,
      client_id: CIMD_ID,
      redirect_uri: CIMD_REDIRECT,
    };
    const bad = await s.form("/token", { ...body, code_verifier: pkce().verifier });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    const ok = await s.form("/token", { ...body, code_verifier: p.verifier });
    expect(ok.status).toBe(200);
    const t = (await ok.json()) as Record<string, unknown>;
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(1800);
    expect(t.access_token).toMatch(/^at_/);
    expect(t.refresh_token).toMatch(/^rt_/);
    const again = await s.form("/token", { ...body, code_verifier: p.verifier });
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    // The first use is revoked once the code comes back.
    const h = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${t.access_token as string}` },
    });
    expect(h.status).toBe(401);
  });

  it("rotates refresh tokens in the same response and revokes the grant on reuse", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const r1 = await s.form("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CIMD_ID,
    });
    const t1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(r1.status).toBe(200);
    expect(t1.refresh_token).not.toBe(tokens.refresh_token);
    const r2 = await s.form("/token", {
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: CIMD_ID,
    });
    const t2 = (await r2.json()) as { access_token: string; refresh_token: string };
    expect(r2.status).toBe(200);
    // The first refresh token is now two rotations old: reuse revokes everything.
    const reuse = await s.form("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CIMD_ID,
    });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
    const after = await s.form("/token", {
      grant_type: "refresh_token",
      refresh_token: t2.refresh_token,
      client_id: CIMD_ID,
    });
    expect(after.status).toBe(400);
    const h = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${t2.access_token}` },
    });
    expect(h.status).toBe(401);
  });

  it("revokes a grant through /revoke", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const r = await s.form("/revoke", { token: tokens.refresh_token, client_id: CIMD_ID });
    expect(r.status).toBe(200);
    const h = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(h.status).toBe(401);
  });

  it("keeps refresh tokens across a restart, stored as hashes in a 0600 file", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    await s.close();
    open.pop();
    const file = join(s.http.oauthDir, "grants.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(tokens.refresh_token);
    expect(raw).not.toContain(tokens.access_token);
    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const s2 = await start({ oauthDir: s.http.oauthDir });
    // The access token lived in memory: gone. The refresh token still works.
    const r = await s2.form("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CIMD_ID,
    });
    expect(r.status).toBe(200);
  });

  it("revoke-all, written while the server runs, revokes existing grants", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    await new Promise((r) => setTimeout(r, 20));
    const { writeRevokeMarker } = await import("../src/oauth/grants.js");
    writeRevokeMarker(s.http.oauthDir);
    const h = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(h.status).toBe(401);
    // New sign-ins work again.
    const again = await s.signIn();
    const h2 = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${again.tokens.access_token}` },
    });
    expect(h2.status).toBe(200);
  });

  it("supports pre-registered public clients with exact redirect URIs", async () => {
    const s = await start({
      clientsJson: {
        clients: [
          {
            client_id: "fake-prereg-client-0001",
            client_name: "Invented Desktop App",
            redirect_uris: ["https://app.example.test/oauth/callback"],
          },
        ],
      },
    });
    const p = pkce();
    const a = await s.startAuthorize(
      authParams(s, p.challenge, {
        client_id: "fake-prereg-client-0001",
        redirect_uri: "https://app.example.test/oauth/callback",
      }),
    );
    expect(a.res.status).toBe(200);
    expect(a.html).toContain("pre-registered");
    const other = await s.startAuthorize(
      authParams(s, p.challenge, {
        client_id: "fake-prereg-client-0001",
        redirect_uri: "https://app.example.test/oauth/callback2",
      }),
    );
    expect(other.res.status).toBe(400);
    const { tokens } = await s.signIn(
      "fake-prereg-client-0001",
      "https://app.example.test/oauth/callback",
    );
    expect(tokens.access_token).toMatch(/^at_/);
  });
});

describe("MCP over HTTP", () => {
  it("lists the same tools as stdio and calls them with a valid token", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const { client } = await s.mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    const { connect } = await import("./helpers/setup.js");
    const stdio = await connect();
    const stdioTools = (await stdio.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools.map((t) => t.name).sort()).toEqual(stdioTools);
    const r = await client.callTool({ name: "wa_list_worlds", arguments: {} });
    expect(r.isError).not.toBe(true);
    await client.close();
  });

  it("binds a session to its grant and keeps state per session", async () => {
    const s = await start();
    const a = await s.signIn();
    const b = await s.signIn();
    const ca = await s.mcpClient(a.tokens.access_token);
    const sid = ca.transport.sessionId!;
    expect(sid).toBeTruthy();
    // Grant B cannot use grant A's session.
    const r = await s.get("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${b.tokens.access_token}`,
        "mcp-session-id": sid,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
    const cb = await s.mcpClient(b.tokens.access_token);
    expect(cb.transport.sessionId).not.toBe(sid);
    expect(s.h.sessions.count).toBe(2);
    await ca.client.close();
    await cb.client.close();
  });

  it("logs tool calls with identifiers only: no content, no key", async () => {
    const s = await start();
    const { tokens } = await s.signIn();
    const { client } = await s.mcpClient(tokens.access_token);
    await client.callTool({
      name: "wa_get",
      arguments: { type: "article", id: "article-open-0001" },
    });
    await client.callTool({
      name: "wa_get",
      arguments: { type: "article", id: "article-missing-9999" },
    });
    await client.close();
    const tool = logLines(s).filter((l) => l.event === "tool");
    expect(tool[0]).toMatchObject({
      tool: "wa_get",
      type: "article",
      element: "article-open-0001",
      world: "world-open-0001",
      result: "ok",
    });
    expect(typeof tool[0]!.ms).toBe("number");
    expect(tool[1]).toMatchObject({ element: "article-missing-9999" });
    expect(tool[1]!.result).not.toBe("ok");
    const raw = readdirSync(s.http.logDir)
      .map((f) => readFileSync(join(s.http.logDir, f), "utf8"))
      .join("");
    expect(raw).not.toContain("Invented Article 1");
    expect(raw).not.toContain(FAKE_APP_KEY);
    expect(raw).not.toContain(FAKE_TOKEN);
    expect(raw).not.toContain(tokens.access_token);
  });
});

describe("health", () => {
  it("/healthz answers without any World Anvil call, and 503 when a folder is gone", async () => {
    const s = await start();
    const r = await s.get("/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
    expect(s.fake.calls).toHaveLength(0);
    rmSync(s.config.backupDir, { recursive: true, force: true });
    const bad = await s.get("/healthz");
    expect(bad.status).toBe(503);
    expect(await bad.json()).toEqual({ status: "error", failing: ["backups"] });
    expect(s.fake.calls).toHaveLength(0);
  });

  it("/healthz/worldanvil needs a token, then reports ok and a duration only", async () => {
    const s = await start();
    expect((await s.get("/healthz/worldanvil")).status).toBe(401);
    const { tokens } = await s.signIn();
    const r = await s.get("/healthz/worldanvil", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const body = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ms", "worldAnvil"]);
    expect(body.worldAnvil).toBe("ok");
  });
});
