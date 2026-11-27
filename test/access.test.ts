import { describe, expect, it } from "vitest";
import { connect, untrustedJson } from "./helpers/setup.js";

const notFoundText = (type: string, id: string) =>
  `Not found: ${type} "${id}" does not exist or is not accessible.`;

describe("access levels", () => {
  it("wa_list_worlds hides blocked worlds and shows each level", async () => {
    const { call } = await connect();
    const r = await call("wa_list_worlds");
    expect(r.isError).toBe(false);
    const worlds = untrustedJson(r.text) as { id: string; accessLevel: string }[];
    expect(worlds.map((w) => [w.id, w.accessLevel])).toEqual([
      ["world-open-0001", "read_only"],
      ["world-edit-0003", "edit_only"],
    ]);
    expect(r.text).not.toContain("world-blocked-0002");
    expect(r.text).not.toContain("Testland Hidden");
  });

  it("wa_get on a blocked world answers exactly like a missing one, without calling World Anvil", async () => {
    const { call, fake } = await connect();
    const blocked = await call("wa_get", { type: "world", id: "world-blocked-0002" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain(notFoundText("world", "world-blocked-0002"));
    expect(fake.calls).toHaveLength(0);

    const missing = await call("wa_get", { type: "world", id: "world-missing-9999" });
    expect(missing.text).toContain(notFoundText("world", "world-missing-9999"));
  });

  it("does not leak a blocked world through a child read by ID", async () => {
    const { call } = await connect();
    for (const [type, id] of [
      ["secret", "secret-blocked-0001"],
      ["article", "article-blocked-0001"],
      ["timeline", "timeline-blocked-0001"],
      ["history", "history-blocked-0001"],
    ] as const) {
      const r = await call("wa_get", { type, id });
      expect(r.isError, `${type} ${id}`).toBe(true);
      expect(r.text).toContain(notFoundText(type, id));
      expect(r.text).not.toContain("Should never be shown");
      expect(r.text).not.toMatch(/Hidden/);
    }
  });

  it("does not leak a blocked child even when read at granularity -1 (no world field)", async () => {
    const { call } = await connect();
    const r = await call("wa_get", {
      type: "secret",
      id: "secret-blocked-0001",
      granularity: "-1",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(notFoundText("secret", "secret-blocked-0001"));
  });

  it("resolves a history event's world through its timeline", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_get", { type: "history", id: "history-open-0001" });
    expect(r.isError).toBe(false);
    expect(fake.calls.map((c) => `${c.method} ${c.path} ${c.query.granularity ?? ""}`)).toEqual([
      "GET history 1",
      "GET history 2", // timelines only appear at granularity 2
      "GET timeline 1",
    ]);
  });

  it("resolves a secret without world field through its article", async () => {
    const { call } = await connect();
    const r = await call("wa_get", { type: "secret", id: "secret-open-noworld-0001" });
    expect(r.isError).toBe(false);
    expect(untrustedJson(r.text)).toMatchObject({ title: "Secret Without World" });
  });

  it("refuses when no parent chain leads to a world", async () => {
    const { call } = await connect();
    const r = await call("wa_get", { type: "secret", id: "secret-orphan-0001" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not determine which world/);
    expect(r.text).not.toContain("Orphan Secret");
  });

  it("caches the resolved world for the session", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "history", id: "history-open-0001" });
    const before = fake.calls.length;
    await call("wa_get", { type: "history", id: "history-open-0001" });
    expect(fake.calls.length - before).toBe(1); // only the read itself
  });

  it("wa_list and wa_list_articles check access before calling World Anvil", async () => {
    const { call, fake } = await connect();
    const a = await call("wa_list_articles", { world_id: "world-blocked-0002" });
    const b = await call("wa_list", { type: "secret", parent_id: "world-blocked-0002" });
    expect(a.isError && b.isError).toBe(true);
    expect(a.text).toContain(notFoundText("world", "world-blocked-0002"));
    expect(b.text).toContain(notFoundText("world", "world-blocked-0002"));
    expect(fake.calls).toHaveLength(0);
  });

  it("lists an unlisted (read_only) world", async () => {
    const { call } = await connect();
    const r = await call("wa_list", { type: "timeline", parent_id: "world-open-0001" });
    expect(r.isError).toBe(false);
    expect(untrustedJson(r.text)).toEqual([
      { id: "timeline-open-0001", title: "Invented Timeline", updateDate: expect.any(Object) },
    ]);
  });
});
