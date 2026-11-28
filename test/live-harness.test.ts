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

describe("live-test harness guard, write mode", () => {
  function writeSetup() {
    const sent: string[] = [];
    const recorded: string[] = [];
    const removed: string[] = [];
    let n = 0;
    const inner = (async (input: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      sent.push(`${init.method ?? "GET"} ${u.pathname}`);
      if (u.pathname.endsWith("/world/articles")) {
        return new Response(
          JSON.stringify({ success: true, entities: [{ id: "article-in-test-0001" }] }),
        );
      }
      if (init.method === "PUT")
        return new Response(JSON.stringify({ id: `created-${++n}`, title: "x" }));
      return new Response("{}");
    }) as typeof fetch;
    const ledgerIds = new Set(["ledger-timeline-0001"]);
    const ledger = {
      has: (id: string) => ledgerIds.has(id),
      record: (_t: string, id: string) => {
        recorded.push(id);
        ledgerIds.add(id);
      },
      remove: (id: string) => {
        removed.push(id);
        ledgerIds.delete(id);
      },
    };
    const g = createGuardedFetch(inner, { testWorldId: TEST_WORLD, ledger, readOnly: false });
    const put = (path: string, body: unknown) =>
      g.fetch(`${B}/${path}`, { method: "PUT", body: JSON.stringify(body) });
    return { ...g, sent, recorded, removed, put };
  }

  it("accepts a create that names the test world, and records it in the ledger", async () => {
    const g = writeSetup();
    await g.put("article", { title: "MCP-TEST-a", world: { id: TEST_WORLD } });
    expect(g.recorded).toEqual(["created-1"]);
    await g.fetch(`${B}/article?id=created-1`, { method: "PATCH", body: "{}" });
    expect(g.sent).toHaveLength(2);
  });

  it("accepts a create without world whose parent is in the ledger or discovered", async () => {
    const g = writeSetup();
    await g.put("history", {
      title: "MCP-TEST-event",
      timelines: [{ id: "ledger-timeline-0001" }],
    });
    await g.fetch(`${B}/world/articles?id=${TEST_WORLD}`, { method: "POST", body: "{}" });
    await g.put("secret", { title: "MCP-TEST-secret", article: { id: "article-in-test-0001" } });
    expect(g.recorded).toEqual(["created-1", "created-2"]);
  });

  it.each([
    ["no world and no parent", { title: "MCP-TEST-x" }],
    [
      "a parent that is not known to be in the test world",
      { title: "MCP-TEST-x", article: { id: "article-elsewhere-0001" } },
    ],
    ["another world", { title: "MCP-TEST-x", world: { id: "world-other-0002" } }],
    [
      "another world even with a known parent",
      {
        title: "MCP-TEST-x",
        world: { id: "world-other-0002" },
        timelines: [{ id: "ledger-timeline-0001" }],
      },
    ],
    ["a title without the prefix", { title: "Real", world: { id: TEST_WORLD } }],
  ])("refuses a create with %s before sending it", async (_label, body) => {
    const g = writeSetup();
    await expect(g.put("secret", body)).rejects.toThrow(HarnessError);
    expect(g.sent).toHaveLength(0);
  });

  it("removes deleted elements from the ledger", async () => {
    const g = writeSetup();
    await g.fetch(`${B}/timeline?id=ledger-timeline-0001`, { method: "DELETE" });
    expect(g.removed).toEqual(["ledger-timeline-0001"]);
    await expect(
      g.fetch(`${B}/timeline?id=ledger-timeline-0001`, { method: "DELETE" }),
    ).rejects.toThrow(/not in the ledger/);
  });
});

describe("live report checks", () => {
  it("fails the run when any check failed, including late ones", async () => {
    const { LiveReport } = await import("../live/report.js");
    const r = new LiveReport();
    r.check("fine", true);
    expect(() => r.assertAllPassed()).not.toThrow();
    r.check("cleanup: delete subscribergroup", false, "Refused");
    expect(() => r.assertAllPassed()).toThrow(
      /1 live check\(s\) failed: cleanup: delete subscribergroup/,
    );
  });

  it("masks IDs and UUIDs in check details", async () => {
    const { LiveReport } = await import("../live/report.js");
    const r = new LiveReport();
    r.hide("created-article-0001");
    r.check(
      "x",
      false,
      'Refused: subscribergroup "0a1b2c3d-1111-2222-3333-444455556666" and article "created-article-0001" were read',
    );
    const detail = r.checks[0]!.detail!;
    expect(detail).not.toMatch(/0a1b2c3d|created-article-0001/);
    expect(detail.match(/<id>/g)).toHaveLength(2);
  });
});

describe("live-test harness guard, stage E reads", () => {
  function readSetup(readOnly = true) {
    const sent: string[] = [];
    const lists: Record<string, unknown[]> = {
      "/world/maps": [{ id: "map-in-test-0001" }],
      "/map/layers": [{ id: "layer-in-test-0001" }],
      "/world/images": [{ id: 501 }],
      "/user/blocktemplates": [{ id: "blocktemplate-own-0001" }],
      "/blocktemplate/blocktemplateparts": [{ id: "blocktemplatepart-own-0001" }],
      "/markertypes": [{ id: "markertype-shared-0001" }],
      "/rpgsystems": [{ id: 7 }],
    };
    const inner = (async (input: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      sent.push(`${init.method ?? "GET"} ${u.pathname}`);
      const key = u.pathname.replace(new URL(B).pathname, "");
      if (key === "/identity") return new Response(JSON.stringify({ id: "user-own-0001" }));
      if (lists[key]) return new Response(JSON.stringify({ success: true, entities: lists[key] }));
      if (init.method === "PUT") return new Response(JSON.stringify({ id: "created-1" }));
      return new Response("{}");
    }) as typeof fetch;
    const ledger = { has: () => false, record: () => {}, remove: () => {} };
    return {
      ...createGuardedFetch(inner, { testWorldId: TEST_WORLD, ledger, readOnly }),
      sent,
    };
  }
  const post = (g: ReturnType<typeof readSetup>, path: string) =>
    g.fetch(`${B}/${path}`, { method: "POST", body: "{}" });

  it("allows child lists of discovered elements, and reading what they return", async () => {
    const g = readSetup();
    await post(g, `world/maps?id=${TEST_WORLD}`);
    await post(g, "map/layers?id=map-in-test-0001");
    await g.fetch(`${B}/layer?id=layer-in-test-0001&granularity=2`);
    expect(g.sent).toHaveLength(3);
    await expect(post(g, "map/layers?id=map-elsewhere-0001")).rejects.toThrow(HarnessError);
  });

  it("matches numeric ids to the type they were listed as", async () => {
    const g = readSetup();
    await post(g, `world/images?id=${TEST_WORLD}`);
    await g.fetch(`${B}/image?id=501&granularity=2`);
    // The same number as a marker is another element, perhaps in another world.
    await expect(g.fetch(`${B}/marker?id=501&granularity=2`)).rejects.toThrow(HarnessError);
  });

  it("allows the owner's own profile and block templates, and shared lists, read-only", async () => {
    const g = readSetup();
    await expect(g.fetch(`${B}/user?id=user-own-0001`)).rejects.toThrow(/token's own user/);
    await g.fetch(`${B}/identity`);
    await g.fetch(`${B}/user?id=user-own-0001&granularity=0`);
    await expect(g.fetch(`${B}/user?id=user-other-0002`)).rejects.toThrow(HarnessError);
    await post(g, "user/blocktemplates?id=user-own-0001");
    await expect(post(g, "user/blocktemplates?id=user-other-0002")).rejects.toThrow(HarnessError);
    await post(g, "blocktemplate/blocktemplateparts?id=blocktemplate-own-0001");
    await g.fetch(`${B}/blocktemplatepart?id=blocktemplatepart-own-0001&granularity=0`);
    await post(g, "markertypes");
    await post(g, "rpgsystems");
    await g.fetch(`${B}/markertype?id=markertype-shared-0001&granularity=0`);
    await g.fetch(`${B}/rpgsystem?id=7&granularity=0`);
    await expect(post(g, "markertypes?id=x")).rejects.toThrow(/takes no parent/);
  });

  it("never lets an account or shared element prove a create, nor be written", async () => {
    const g = readSetup(false);
    await g.fetch(`${B}/identity`);
    await post(g, "user/blocktemplates?id=user-own-0001");
    await expect(
      g.fetch(`${B}/blocktemplatepart`, {
        method: "PUT",
        body: JSON.stringify({
          title: "MCP-TEST-part",
          template: { id: "blocktemplate-own-0001" },
        }),
      }),
    ).rejects.toThrow(/parent known to be in it/);
    await expect(
      g.fetch(`${B}/blocktemplate?id=blocktemplate-own-0001`, { method: "PATCH", body: "{}" }),
    ).rejects.toThrow(/not in the ledger/);
  });
});
