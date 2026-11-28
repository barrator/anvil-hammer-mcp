/** Unit tests of the authorization pieces. Offline; every value is invented. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/errors.js";
import { loadSecrets, readSecretFile } from "../src/config/secrets.js";
import { loadHttpConfig, parsePublicUrl } from "../src/http/config.js";
import { TechLog } from "../src/http/techlog.js";
import { CimdError, CimdResolver, cacheTtlMs } from "../src/oauth/cimd.js";
import { ClientRegistry, parseClientsFile } from "../src/oauth/clients.js";
import { GrantStore } from "../src/oauth/grants.js";
import { AttemptLimiter } from "../src/oauth/limits.js";
import {
  MIN_PASSPHRASE_LENGTH,
  hashPassphrase,
  parsePassphraseHash,
  verifyPassphrase,
} from "../src/oauth/passphrase.js";
import { isAllowedRedirectForm, redirectMatches } from "../src/oauth/redirects.js";
import { Redactor } from "../src/redact.js";
import { CIMD_ID, cimdDoc, fakeCimdFetch } from "./helpers/http.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("client metadata documents", () => {
  const resolver = (docs: Parameters<typeof fakeCimdFetch>[0], hosts = ["claude.ai"]) => {
    const f = fakeCimdFetch(docs);
    return { r: new CimdResolver({ hosts, fetch: f.fetch }), calls: f.calls };
  };
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return "accepted";
    } catch (e) {
      return e instanceof CimdError ? e.reason : `other: ${String(e)}`;
    }
  };

  it("accepts a valid document and caches it", async () => {
    const { r, calls } = resolver({ [CIMD_ID]: cimdDoc(CIMD_ID) });
    const c = await r.resolve(CIMD_ID);
    expect(c.client_name).toBe("Invented Test Client");
    expect(c.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(c.token_endpoint_auth_method).toBe("none");
    await r.resolve(CIMD_ID);
    expect(calls).toHaveLength(1);
  });

  it("refuses a host outside the list without any network call", async () => {
    const id = "https://evil.example/oauth/client.json";
    const { r, calls } = resolver({ [id]: cimdDoc(id) });
    expect(await reason(r.resolve(id))).toBe("host_not_allowed");
    expect(calls).toHaveLength(0);
  });

  it("refuses http, a port, a missing path and non-canonical URLs", async () => {
    const { r, calls } = resolver({});
    expect(await reason(r.resolve("http://claude.ai/oauth/x"))).toBe("not_https");
    expect(await reason(r.resolve("https://claude.ai:8443/oauth/x"))).toBe("invalid_url");
    expect(await reason(r.resolve("https://claude.ai/"))).toBe("invalid_url");
    expect(await reason(r.resolve("https://CLAUDE.ai/oauth/x"))).toBe("invalid_url");
    expect(await reason(r.resolve("https://claude.ai/oauth/x#frag"))).toBe("invalid_url");
    expect(calls).toHaveLength(0);
  });

  it("does not follow a redirect", async () => {
    const { r } = resolver({
      [CIMD_ID]: { status: 302, headers: { location: "https://evil.example/doc.json" }, body: "" },
    });
    expect(await reason(r.resolve(CIMD_ID))).toBe("redirect");
  });

  it("refuses a document over 5 KB, declared or streamed", async () => {
    const big = cimdDoc(CIMD_ID, { padding: "x".repeat(6000) });
    const { r } = resolver({ [CIMD_ID]: big });
    expect(await reason(r.resolve(CIMD_ID))).toBe("too_large");
    const declared = {
      ...cimdDoc(CIMD_ID),
      headers: { "content-type": "application/json", "content-length": "9000" },
    };
    expect(await reason(resolver({ [CIMD_ID]: declared }).r.resolve(CIMD_ID))).toBe("too_large");
  });

  it("refuses a document whose client_id does not match the URL", async () => {
    const { r } = resolver({ [CIMD_ID]: cimdDoc("https://claude.ai/oauth/another-client") });
    expect(await reason(r.resolve(CIMD_ID))).toBe("client_id_mismatch");
  });

  it("refuses non-JSON, a confidential client, a secret and bad redirect URIs", async () => {
    const html = { headers: { "content-type": "text/html" }, body: "<html></html>" };
    expect(await reason(resolver({ [CIMD_ID]: html }).r.resolve(CIMD_ID))).toBe("not_json");
    const broken = { headers: { "content-type": "application/json" }, body: "{not json" };
    expect(await reason(resolver({ [CIMD_ID]: broken }).r.resolve(CIMD_ID))).toBe("not_json");
    for (const extra of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { token_endpoint_auth_method: undefined },
    ])
      expect(
        await reason(resolver({ [CIMD_ID]: cimdDoc(CIMD_ID, extra) }).r.resolve(CIMD_ID)),
      ).toBe("auth_method");
    for (const extra of [
      { client_secret: "fake-secret" },
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: [] },
      { client_name: "" },
    ])
      expect(
        await reason(resolver({ [CIMD_ID]: cimdDoc(CIMD_ID, extra) }).r.resolve(CIMD_ID)),
      ).toBe("invalid_document");
  });

  it("reports a timeout", async () => {
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const r = new CimdResolver({ hosts: ["claude.ai"], fetch: slow, timeoutMs: 20 });
    expect(await reason(r.resolve(CIMD_ID))).toBe("timeout");
  });

  it("respects cache headers, within bounds", () => {
    expect(cacheTtlMs(null, 300_000, 86_400_000)).toBe(300_000);
    expect(cacheTtlMs("max-age=60", 300_000, 86_400_000)).toBe(60_000);
    expect(cacheTtlMs("public, max-age=999999", 300_000, 86_400_000)).toBe(86_400_000);
    expect(cacheTtlMs("no-store", 300_000, 86_400_000)).toBe(0);
    expect(cacheTtlMs("no-cache", 300_000, 86_400_000)).toBe(0);
  });

  it("fetches again once the cache entry expired, and not when no-store", async () => {
    let t = 0;
    const f = fakeCimdFetch({ [CIMD_ID]: cimdDoc(CIMD_ID) });
    const r = new CimdResolver({ hosts: ["claude.ai"], fetch: f.fetch, now: () => t });
    await r.resolve(CIMD_ID);
    t += 61_000;
    await r.resolve(CIMD_ID);
    expect(f.calls).toHaveLength(2);
    const ns = {
      ...cimdDoc(CIMD_ID),
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    };
    const g = fakeCimdFetch({ [CIMD_ID]: ns });
    const r2 = new CimdResolver({ hosts: ["claude.ai"], fetch: g.fetch });
    await r2.resolve(CIMD_ID);
    await r2.resolve(CIMD_ID);
    expect(g.calls).toHaveLength(2);
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    expect(isAllowedRedirectForm("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectForm("http://localhost/callback")).toBe(true);
    expect(isAllowedRedirectForm("http://127.0.0.1:9999/callback")).toBe(true);
    expect(isAllowedRedirectForm("http://example.test/callback")).toBe(false);
    expect(isAllowedRedirectForm("https://claude.ai/cb#x")).toBe(false);
    expect(isAllowedRedirectForm("javascript:alert(1)")).toBe(false);
  });

  it("matches exactly, except the port of loopback URIs", () => {
    expect(
      redirectMatches(
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(true);
    expect(
      redirectMatches(
        "https://claude.ai/api/mcp/auth_callback/",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(false);
    expect(redirectMatches("http://localhost:3118/callback", "http://localhost/callback")).toBe(
      true,
    );
    expect(redirectMatches("http://127.0.0.1:50123/callback", "http://127.0.0.1/callback")).toBe(
      true,
    );
    expect(redirectMatches("http://localhost:3118/callback", "http://127.0.0.1/callback")).toBe(
      false,
    );
    expect(redirectMatches("http://localhost:3118/other", "http://localhost/callback")).toBe(false);
    expect(
      redirectMatches(
        "https://claude.ai:444/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(false);
  });
});

describe("passphrase", () => {
  it("hashes with scrypt, verifies, and never stores the passphrase", async () => {
    const h = await hashPassphrase("invented passphrase for tests");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(h).not.toContain("invented");
    const parsed = parsePassphraseHash(h);
    expect(await verifyPassphrase(parsed, "invented passphrase for tests")).toBe(true);
    expect(await verifyPassphrase(parsed, "invented passphrase for test")).toBe(false);
    expect(await verifyPassphrase(parsed, "")).toBe(false);
  });

  it("refuses short passphrases and plain text in the passphrase file", async () => {
    await expect(hashPassphrase("x".repeat(MIN_PASSPHRASE_LENGTH - 1))).rejects.toThrow(
      ConfigError,
    );
    expect(() => parsePassphraseHash("my plain passphrase")).toThrow(/hash-passphrase/);
    expect(() => parsePassphraseHash("scrypt$1024$8$1$AAAA$BBBB")).toThrow(ConfigError);
  });
});

describe("attempt limits", () => {
  it("blocks an address after 5 failures in 15 minutes, and all after 20 in an hour", () => {
    let t = 0;
    const l = new AttemptLimiter(undefined, () => t);
    for (let i = 0; i < 5; i++) l.fail("198.51.100.1");
    expect(l.blockedFor("198.51.100.1")).toBeGreaterThan(0);
    expect(l.blockedFor("198.51.100.2")).toBe(0);
    t += 15 * 60_000 + 1;
    expect(l.blockedFor("198.51.100.1")).toBe(0);
    for (let i = 0; i < 20; i++) l.fail(`198.51.100.${10 + i}`);
    expect(l.blockedFor("198.51.100.99")).toBeGreaterThan(0);
  });
});

describe("pre-registered clients", () => {
  it("parses public clients and refuses secrets, URL ids and bad redirects", () => {
    const ok = parseClientsFile(
      JSON.stringify({
        clients: [
          {
            client_id: "fake-client-0001",
            client_name: "App",
            redirect_uris: ["https://app.example.test/cb"],
          },
        ],
      }),
    );
    expect(ok[0]?.client_id).toBe("fake-client-0001");
    const bad = (c: Record<string, unknown>) => () =>
      parseClientsFile(
        JSON.stringify({
          clients: [
            {
              client_id: "fake-client-0001",
              client_name: "App",
              redirect_uris: ["https://app.example.test/cb"],
              ...c,
            },
          ],
        }),
      );
    expect(bad({ client_secret: "nope" })).toThrow(/public clients/);
    expect(bad({ client_id: "https://claude.ai/x" })).toThrow(ConfigError);
    expect(bad({ redirect_uris: ["http://app.example.test/cb"] })).toThrow(ConfigError);
    expect(bad({ redirect_uris: [] })).toThrow(ConfigError);
  });

  it("picks up clients.json changes without a restart, and keeps the old list on a bad edit", async () => {
    const dir = tmp("ahm-clients-");
    const file = join(dir, "clients.json");
    const reg = new ClientRegistry(file, undefined);
    expect((await reg.lookup("fake-client-0002")).ok).toBe(false);
    writeFileSync(
      file,
      JSON.stringify({
        clients: [
          {
            client_id: "fake-client-0002",
            client_name: "App",
            redirect_uris: ["https://app.example.test/cb"],
          },
        ],
      }),
    );
    expect((await reg.lookup("fake-client-0002")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(file, "{broken");
    expect((await reg.lookup("fake-client-0002")).ok).toBe(true);
    expect((await reg.lookup(CIMD_ID)).ok).toBe(false); // CIMD disabled here
  });
});

describe("grant store", () => {
  const code = (g: GrantStore) =>
    g.createCode({
      clientId: "fake-client",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "x".repeat(43),
      resource: "https://wa.example.test/mcp",
      scopes: ["mcp"],
    });

  it("allows one retry with the previous refresh token within the grace period", () => {
    let t = 1_000_000;
    const g = new GrantStore(tmp("ahm-grants-"), { now: () => t });
    const t0 = g.exchangeCode("fake-client", code(g), undefined, undefined);
    const t1 = g.refresh("fake-client", t0.refresh_token!, undefined, undefined);
    t += 30_000;
    const retry = g.refresh("fake-client", t0.refresh_token!, undefined, undefined);
    expect(retry.refresh_token).not.toBe(t1.refresh_token);
    t += 61_000;
    expect(() => g.refresh("fake-client", t0.refresh_token!, undefined, undefined)).toThrow(
      /invalid/,
    );
    expect(g.familyCount).toBe(0);
  });

  it("expires codes, idle grants and grants past the absolute limit", () => {
    let t = 1_000_000;
    const g = new GrantStore(tmp("ahm-grants-"), { now: () => t });
    const c = code(g);
    t += 5 * 60_000 + 1;
    expect(() => g.exchangeCode("fake-client", c, undefined, undefined)).toThrow(/expired/);
    let tokens = g.exchangeCode("fake-client", code(g), undefined, undefined);
    t += 31 * 24 * 3600_000;
    expect(() => g.refresh("fake-client", tokens.refresh_token!, undefined, undefined)).toThrow();
    tokens = g.exchangeCode("fake-client", code(g), undefined, undefined);
    for (let d = 0; d < 9; d++) {
      t += 10 * 24 * 3600_000;
      tokens = g.refresh("fake-client", tokens.refresh_token!, undefined, undefined);
    }
    t += 10 * 24 * 3600_000; // 100 days after the sign-in
    expect(() => g.refresh("fake-client", tokens.refresh_token!, undefined, undefined)).toThrow();
  });

  it("refuses a refresh by another client, a wider scope and another resource", () => {
    const g = new GrantStore(tmp("ahm-grants-"));
    const t0 = g.exchangeCode("fake-client", code(g), undefined, undefined);
    expect(() => g.refresh("other-client", t0.refresh_token!, undefined, undefined)).toThrow(
      /invalid/,
    );
    expect(() => g.refresh("fake-client", t0.refresh_token!, ["admin"], undefined)).toThrow(
      /scope/,
    );
    expect(() =>
      g.refresh("fake-client", t0.refresh_token!, undefined, "https://other.example/mcp"),
    ).toThrow(/resource/);
  });

  it("keeps at most the configured number of grants", () => {
    let t = 1_000_000;
    const g = new GrantStore(tmp("ahm-grants-"), { now: () => t++, limits: { maxFamilies: 3 } });
    for (let i = 0; i < 5; i++) g.exchangeCode("fake-client", code(g), undefined, undefined);
    expect(g.familyCount).toBe(3);
  });

  it("writes grants.json as 0600 with hashes only", () => {
    const dir = tmp("ahm-grants-");
    const g = new GrantStore(dir);
    const t0 = g.exchangeCode("fake-client", code(g), undefined, undefined);
    const raw = readFileSync(join(dir, "grants.json"), "utf8");
    expect(raw).not.toContain(t0.refresh_token!.split(".")[1]!);
    expect(raw).not.toContain(t0.access_token);
    expect(statSync(join(dir, "grants.json")).mode & 0o777).toBe(0o600);
  });
});

describe("secret files", () => {
  const dir = tmp("ahm-secrets-");
  const file = (name: string, content: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, content, { mode });
    chmodSync(p, mode);
    return p;
  };

  it("refuses missing, empty, world-readable or non-regular files", () => {
    expect(() => readSecretFile("WA_PASSPHRASE_FILE", join(dir, "missing"))).toThrow(
      /does not exist/,
    );
    expect(() => readSecretFile("WA_PASSPHRASE_FILE", file("empty", " \n", 0o600))).toThrow(
      /empty/,
    );
    expect(() => readSecretFile("WA_PASSPHRASE_FILE", file("open", "fake", 0o644))).toThrow(
      /other users \(mode 644\)/,
    );
    expect(() => readSecretFile("WA_PASSPHRASE_FILE", file("ow", "fake", 0o602))).toThrow(
      /other users/,
    );
    mkdirSync(join(dir, "folder"), { recursive: true });
    expect(() => readSecretFile("WA_PASSPHRASE_FILE", join(dir, "folder"))).toThrow(/regular file/);
    expect(readSecretFile("WA_PASSPHRASE_FILE", file("ok", "fake-value\n", 0o400))).toBe(
      "fake-value",
    );
    expect(readSecretFile("WA_PASSPHRASE_FILE", file("grp", "fake-value", 0o640))).toBe(
      "fake-value",
    );
  });

  it("hosted mode takes keys from files only", () => {
    expect(() =>
      loadSecrets(
        { WA_APP_KEY: "fake-app-key-1234", WA_AUTH_TOKEN: "fake-token-5678" },
        { filesOnly: true },
      ),
    ).toThrow(/files only/);
    const s = loadSecrets(
      {
        WA_APP_KEY_FILE: file("k", "fake-app-key-1234", 0o600),
        WA_AUTH_TOKEN_FILE: file("t", "fake-token-5678", 0o600),
      },
      { filesOnly: true },
    );
    expect(s.appKey).toBe("fake-app-key-1234");
  });
});

describe("hosted configuration", () => {
  it("requires an https public origin (http for localhost only)", () => {
    expect(parsePublicUrl("https://wa.example.test").origin).toBe("https://wa.example.test");
    expect(parsePublicUrl("http://127.0.0.1:8080").origin).toBe("http://127.0.0.1:8080");
    expect(() => parsePublicUrl("http://wa.example.test")).toThrow(/https/);
    expect(() => parsePublicUrl("https://wa.example.test/mcp")).toThrow(/origin only/);
    expect(() => parsePublicUrl(undefined)).toThrow(/WA_PUBLIC_URL/);
  });

  it("defaults to claude.ai for metadata documents and Claude's redirect URIs", () => {
    const c = loadHttpConfig({
      WA_PUBLIC_URL: "https://wa.example.test",
      WA_PASSPHRASE_FILE: "/run/secrets/x",
    });
    expect(c.cimdHosts).toEqual(["claude.ai"]);
    expect(c.redirectUris).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(c.port).toBe(8080);
    expect(c.trustedProxies).toEqual([]);
    const off = loadHttpConfig({
      WA_PUBLIC_URL: "https://wa.example.test",
      WA_PASSPHRASE_FILE: "/x",
      WA_OAUTH_CIMD_HOSTS: "none",
    });
    expect(off.cimdHosts).toEqual([]);
    expect(() =>
      loadHttpConfig({
        WA_PUBLIC_URL: "https://wa.example.test",
        WA_PASSPHRASE_FILE: "/x",
        WA_TRUSTED_PROXY: "gateway",
      }),
    ).toThrow(/IP address/);
    expect(() =>
      loadHttpConfig({
        WA_PUBLIC_URL: "https://wa.example.test",
        WA_PASSPHRASE_FILE: "/x",
        WA_OAUTH_REDIRECT_URIS: "http://evil.example/cb",
      }),
    ).toThrow(ConfigError);
  });
});

describe("technical log", () => {
  it("deletes day files older than the retention period and redacts every line", () => {
    const dir = tmp("ahm-logs-");
    let now = new Date("2026-11-28T12:00:00Z");
    const log = new TechLog(dir, 180, new Redactor(["fake-secret-value-123"]), () => now);
    log.write({ event: "server", kind: "started", detail: "fake-secret-value-123" });
    writeFileSync(join(dir, "technical-2026-05-01.jsonl"), "{}\n");
    writeFileSync(join(dir, "technical-2026-06-30.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "kept");
    expect(log.prune()).toBe(1);
    const today = readFileSync(join(dir, "technical-2026-11-28.jsonl"), "utf8");
    expect(today).not.toContain("fake-secret-value-123");
    expect(statSync(join(dir, "technical-2026-11-28.jsonl")).mode & 0o777).toBe(0o600);
    now = new Date("2027-01-01T00:00:00Z");
    expect(log.prune()).toBe(1);
  });
});
