import { describe, expect, it } from "vitest";
import { WorldAnvilApiError, WorldAnvilClient } from "../src/api/client.js";
import { USER_AGENT, WORLD_ANVIL_BASE_URL } from "../src/constants.js";
import { FAKE_APP_KEY, FAKE_TOKEN, createFakeWorldAnvil } from "./helpers/fake-wa.js";

const secrets = { appKey: FAKE_APP_KEY, authToken: FAKE_TOKEN };

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("base URL", () => {
  it("is the World Anvil constant", () => {
    expect(WORLD_ANVIL_BASE_URL).toBe("https://www.worldanvil.com/api/external/boromir");
  });

  it("ignores any environment variable that looks like an override", async () => {
    process.env.WA_BASE_URL = "https://evil.example";
    process.env.WORLD_ANVIL_BASE_URL = "https://evil.example";
    const fake = createFakeWorldAnvil();
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    await c.request("GET", "identity");
    delete process.env.WA_BASE_URL;
    delete process.env.WORLD_ANVIL_BASE_URL;
    expect(fake.calls).toHaveLength(1); // the fake throws for any other host
  });
});

describe("WorldAnvilClient", () => {
  it("sends the required headers", async () => {
    const fake = createFakeWorldAnvil();
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    await c.request("GET", "identity");
    const h = fake.calls[0]!.headers;
    expect(h["x-application-key"]).toBe(FAKE_APP_KEY);
    expect(h["x-auth-token"]).toBe(FAKE_TOKEN);
    expect(h["content-type"]).toBe("application/json");
    expect(h["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(
      /^anvil-hammer-mcp \(https:\/\/github\.com\/[^,]+, \d+\.\d+\.\d+\)$/,
    );
  });

  it("spaces calls by the minimum interval", async () => {
    const fake = createFakeWorldAnvil();
    const k = clock();
    const c = new WorldAnvilClient(secrets, {
      fetch: fake.fetch,
      minIntervalMs: 750,
      now: k.now,
      sleep: k.sleep,
    });
    await Promise.all([
      c.request("GET", "identity"),
      c.request("GET", "identity"),
      c.request("GET", "identity"),
    ]);
    expect(fake.calls).toHaveLength(3);
    expect(k.sleeps).toEqual([750, 750]);
  });

  it("backs off exponentially on 429, then succeeds", async () => {
    let n = 0;
    const fake = createFakeWorldAnvil(undefined, {
      override: () => (n++ < 2 ? new Response("", { status: 429 }) : undefined),
    });
    const k = clock();
    const c = new WorldAnvilClient(secrets, {
      fetch: fake.fetch,
      minIntervalMs: 0,
      backoffBaseMs: 1000,
      now: k.now,
      sleep: k.sleep,
    });
    await expect(c.request("GET", "identity")).resolves.toMatchObject({ id: "user-fake-0001" });
    expect(k.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after the maximum number of retries, with a capped delay", async () => {
    const fake = createFakeWorldAnvil(undefined, {
      override: () => new Response("", { status: 429 }),
    });
    const k = clock();
    const c = new WorldAnvilClient(secrets, {
      fetch: fake.fetch,
      minIntervalMs: 0,
      maxRetries: 3,
      backoffBaseMs: 1000,
      backoffMaxMs: 1500,
      now: k.now,
      sleep: k.sleep,
    });
    await expect(c.request("GET", "identity")).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
    expect(fake.calls).toHaveLength(4);
    expect(k.sleeps).toEqual([1000, 1500, 1500]);
  });

  it("turns an HTML 404 page into a clean not_found error without dumping HTML", async () => {
    const fake = createFakeWorldAnvil();
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    const err = await c.request("GET", "no-such-route").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorldAnvilApiError);
    expect((err as WorldAnvilApiError).kind).toBe("not_found");
    expect((err as Error).message).not.toMatch(/<html|DOCTYPE/i);
  });

  it("rejects an HTML page served with HTTP 200", async () => {
    const fake = createFakeWorldAnvil(undefined, {
      override: () =>
        new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    await expect(c.request("GET", "identity")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects a non-JSON body", async () => {
    const fake = createFakeWorldAnvil(undefined, {
      override: () => new Response("plain text", { status: 200 }),
    });
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    await expect(c.request("GET", "identity")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("treats success:false with HTTP 200 as an error", async () => {
    const fake = createFakeWorldAnvil(undefined, {
      override: () =>
        new Response(JSON.stringify({ success: false, error: "resource_not_found" }), {
          status: 200,
        }),
    });
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    await expect(c.request("GET", "identity")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("walks every page with string limit/offset", async () => {
    const fake = createFakeWorldAnvil();
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    const { items, complete } = await c.listAll("world/articles", "world-open-0001");
    expect(items).toHaveLength(120);
    expect(complete).toBe(true);
    expect(fake.calls.map((x) => x.body)).toEqual([
      { limit: "50", offset: "0" },
      { limit: "50", offset: "50" },
      { limit: "50", offset: "100" },
    ]);
  });

  it("stops after an exact multiple of the page size", async () => {
    const fake = createFakeWorldAnvil();
    fake.data.articles.splice(100); // 100 articles in world-open-0001
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    const { items } = await c.listAll("world/articles", "world-open-0001");
    expect(items).toHaveLength(100);
    expect(fake.calls).toHaveLength(3); // the third, empty page confirms the end
  });

  it("reports an incomplete list when the page cap is reached", async () => {
    const fake = createFakeWorldAnvil();
    const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
    const r = await c.listAll("world/articles", "world-open-0001", {}, 1);
    expect(r.complete).toBe(false);
    expect(r.items).toHaveLength(50);
  });
});
