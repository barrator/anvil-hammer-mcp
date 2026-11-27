import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldAnvilClient } from "../src/api/client.js";
import { Logger, REDACTED, Redactor } from "../src/redact.js";
import { FAKE_APP_KEY, FAKE_TOKEN, createFakeWorldAnvil, seedData } from "./helpers/fake-wa.js";
import { connect } from "./helpers/setup.js";

const secrets = { appKey: FAKE_APP_KEY, authToken: FAKE_TOKEN };
const leaks = (text: string) =>
  [FAKE_APP_KEY, FAKE_TOKEN, encodeURIComponent(FAKE_TOKEN)].some((s) => text.includes(s));

/** A World Anvil that echoes the whole request, keys included, in its error body. */
const echoing = (status: number) => ({
  override: (call: { headers: Record<string, string>; path: string }) =>
    new Response(
      JSON.stringify({
        success: false,
        status: `echo ${call.headers["x-auth-token"]}`,
        error: {
          summary: `bad request with key ${call.headers["x-application-key"]}`,
          traceStack: JSON.stringify(call),
        },
      }),
      { status },
    ),
});

afterEach(() => vi.restoreAllMocks());

describe("error scrubbing", () => {
  it("removes keys echoed back by World Anvil in an error body", async () => {
    for (const status of [400, 401, 422, 500, 200]) {
      const fake = createFakeWorldAnvil(undefined, echoing(status));
      const c = new WorldAnvilClient(secrets, { fetch: fake.fetch, minIntervalMs: 0 });
      const err = await c.request("GET", "identity").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(leaks((err as Error).message), `status ${status}: ${(err as Error).message}`).toBe(
        false,
      );
      expect((err as Error).message).toContain(REDACTED);
    }
  });

  it("removes keys from network error messages", async () => {
    const c = new WorldAnvilClient(secrets, {
      minIntervalMs: 0,
      fetch: (async () => {
        throw new Error(`connect failed for token=${FAKE_TOKEN}`);
      }) as typeof fetch,
    });
    const err = await c.request("GET", "identity").catch((e: Error) => e);
    expect(leaks((err as Error).message)).toBe(false);
  });

  it("removes keys from tool results, even inside world content", async () => {
    const data = seedData();
    data.articles[0]!.content = `Someone pasted ${FAKE_TOKEN} and ${encodeURIComponent(FAKE_APP_KEY)} here.`;
    const { call } = await connect({ data });
    const r = await call("wa_get", { type: "article", id: "article-open-0001" });
    expect(r.isError).toBe(false);
    expect(leaks(r.text)).toBe(false);
    expect(r.text).toContain(REDACTED);
  });

  it("removes keys from tool error results", async () => {
    const { call } = await connect({ fake: echoing(422) });
    const r = await call("wa_list_worlds");
    expect(r.isError).toBe(true);
    expect(leaks(r.text)).toBe(false);
  });

  it("removes keys from log lines", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    new Logger(new Redactor([FAKE_APP_KEY, FAKE_TOKEN])).error(
      "failed:",
      new Error(`with ${FAKE_TOKEN}`),
    );
    const logged = spy.mock.calls.flat().join(" ");
    expect(leaks(logged)).toBe(false);
    expect(logged).toContain(REDACTED);
  });

  it("redacts JSON-escaped and URL-encoded forms", () => {
    const r = new Redactor(['key"with/slash+plus']);
    expect(r.redact(JSON.stringify({ a: 'key"with/slash+plus' }))).not.toContain("slash+plus");
    expect(r.redact(encodeURIComponent('key"with/slash+plus'))).toBe(REDACTED);
  });
});
