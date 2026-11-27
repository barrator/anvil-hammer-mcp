import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessError, Ledger, createGuardedFetch, loadLiveConfig } from "../live/harness.js";
import { WORLD_ANVIL_BASE_URL } from "../src/constants.js";

const TEST_WORLD = "world-test-fake-0001";
const B = WORLD_ANVIL_BASE_URL;

function setup(readOnly = true) {
  const sent: string[] = [];
  const inner = (async (input: string | URL) => {
    const u = new URL(String(input));
    sent.push(u.pathname + u.search);
    if (u.pathname.endsWith("/world/articles")) {
      return new Response(
        JSON.stringify({ success: true, entities: [{ id: "article-in-test-0001" }] }),
      );
    }
    return new Response("{}");
  }) as typeof fetch;
  const ledger = { has: (id: string) => id === "ledger-element-0001" };
  const g = createGuardedFetch(inner, { testWorldId: TEST_WORLD, ledger, readOnly });
  return { ...g, sent };
}

describe("live-test harness guard", () => {
  it("allows the test world and elements discovered in it", async () => {
    const g = setup();
    await g.fetch(`${B}/identity`);
    await g.fetch(`${B}/world?id=${TEST_WORLD}&granularity=0`);
    await g.fetch(`${B}/world/articles?id=${TEST_WORLD}`, { method: "POST", body: "{}" });
    await g.fetch(`${B}/article?id=article-in-test-0001&granularity=1`);
    await g.fetch(`${B}/article?id=ledger-element-0001&granularity=1`);
    expect(g.sent).toHaveLength(5);
  });

  it.each([
    ["another world", `${B}/world?id=world-other-0002&granularity=0`, "GET"],
    ["listing another world", `${B}/world/articles?id=world-other-0002`, "POST"],
    ["an undiscovered element", `${B}/secret?id=secret-unknown-0001&granularity=2`, "GET"],
    ["another host", "https://example.com/api/external/boromir/identity", "GET"],
    ["a write in read-only mode", `${B}/article?id=ledger-element-0001`, "PATCH"],
    ["a create in read-only mode", `${B}/article`, "PUT"],
    ["a delete in read-only mode", `${B}/article?id=ledger-element-0001`, "DELETE"],
  ])("refuses %s before sending it", async (_label, url, method) => {
    const g = setup();
    await expect(g.fetch(url, { method, body: "{}" })).rejects.toThrow(HarnessError);
    expect(g.sent).toHaveLength(0);
  });

  it("with writes enabled, still limits them to the ledger, MCP-TEST- titles and the test world", async () => {
    const g = setup(false);
    await expect(
      g.fetch(`${B}/article?id=article-in-test-0001`, { method: "PATCH", body: "{}" }),
    ).rejects.toThrow(/not in the ledger/);
    await expect(
      g.fetch(`${B}/article`, {
        method: "PUT",
        body: JSON.stringify({ title: "Real title", world: { id: TEST_WORLD } }),
      }),
    ).rejects.toThrow(/MCP-TEST-/);
    await expect(
      g.fetch(`${B}/article`, {
        method: "PUT",
        body: JSON.stringify({ title: "MCP-TEST-x", world: { id: "world-other-0002" } }),
      }),
    ).rejects.toThrow(/outside the test world/);
    await g.fetch(`${B}/article?id=ledger-element-0001`, { method: "PATCH", body: "{}" });
    expect(g.sent).toHaveLength(1);
  });
});

describe("live-test config and ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahm-live-"));

  it("requires testWorldId and rejects unknown keys", () => {
    const p = join(dir, "a.json");
    writeFileSync(p, JSON.stringify({ testWorldId: "world-test-fake-0001" }));
    expect(loadLiveConfig(p).testWorldId).toBe("world-test-fake-0001");
    writeFileSync(p, JSON.stringify({}));
    expect(() => loadLiveConfig(p)).toThrow(/testWorldId/);
    writeFileSync(p, JSON.stringify({ testWorldId: "x", extraWorld: "y" }));
    expect(() => loadLiveConfig(p)).toThrow(/Unknown key/);
    expect(() => loadLiveConfig(join(dir, "missing.json"))).toThrow(/not found/);
  });

  it("only records MCP-TEST- elements", () => {
    const l = new Ledger(join(dir, "ledger.json"));
    expect(() => l.record("article", "a-1", "Real article")).toThrow(/MCP-TEST-/);
    l.record("article", "a-2", "MCP-TEST-sample");
    expect(new Ledger(join(dir, "ledger.json")).has("a-2")).toBe(true);
  });
});

describe("live report", () => {
  it("ignores the success flag when comparing with the registry", async () => {
    const { LiveReport } = await import("../live/report.js");
    const r = new LiveReport();
    r.type("secret").listFields = ["id", "title", "success", "seeded"];
    const cmp = r.registryComparison().secret!;
    expect(cmp.notInRegistry).toEqual(["seeded"]);
    expect(cmp.observed).toEqual(["id", "title"]);
  });
});
