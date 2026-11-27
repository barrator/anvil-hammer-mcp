import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/registry/index.js";
import { connect } from "./helpers/setup.js";

describe("registry", () => {
  it("covers the stage A types", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      ["article", "category", "history", "secret", "subscribergroup", "timeline", "world"].sort(),
    );
  });

  it.each(Object.values(REGISTRY))("$name is internally consistent", (t) => {
    expect(t.granularities).toContain(t.defaultGranularity);
    if (t.world) expect(t.granularities).toContain(t.world.granularity);
    for (const p of t.parents) {
      expect(REGISTRY[p.type], `parent type ${p.type}`).toBeDefined();
      expect(t.granularities).toContain(p.granularity);
    }
    if (t.name !== "world") {
      expect(t.world || t.parents.length, "needs a way to reach its world").toBeTruthy();
      expect(t.list?.parentType).toBe("world");
    }
    for (const [name, f] of Object.entries(t.fields)) {
      expect(["verified", "unverified"], name).toContain(f.status);
    }
  });

  it("nothing is marked verified before a live run has observed it", () => {
    const verified = Object.values(REGISTRY).flatMap((t) =>
      Object.entries(t.fields)
        .filter(([, f]) => f.status === "verified")
        .map(([n]) => `${t.name}.${n}`),
    );
    // Update this list only from a live-test report.
    expect(verified).toEqual([]);
  });

  it("wa_describe lists types and details one type and one template", async () => {
    const { call } = await connect();
    const all = await call("wa_describe");
    expect(all.text).toMatch(/read-only/);
    expect(all.text).toContain('"type": "history"');
    const cat = await call("wa_describe", { type: "category" });
    expect(cat.text).toContain("parentCategory");
    const tpl = await call("wa_describe", { type: "article", template: "organization" });
    expect(tpl.text).toContain("internal type ID");
    const bad = await call("wa_describe", { type: "secret", template: "person" });
    expect(bad.isError).toBe(true);
  });
});
