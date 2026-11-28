import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/registry/index.js";
import { LIVE_OBSERVED } from "../src/registry/observed.js";
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

  it("marks verified exactly the fields observed live, nothing else", () => {
    const verified = Object.values(REGISTRY).flatMap((t) =>
      Object.entries(t.fields)
        .filter(([, f]) => f.status === "verified")
        .map(([n]) => `${t.name}.${n}`),
    );
    const observed = Object.entries(LIVE_OBSERVED).flatMap(([t, o]) =>
      o.fields.map((f) => `${t}.${f}`),
    );
    expect(verified.sort()).toEqual(observed.sort());
  });

  it("keeps fields of types whose field names were never reported entirely unverified", () => {
    for (const name of ["subscribergroup", "timeline", "history"]) {
      const t = REGISTRY[name]!;
      expect(
        Object.values(t.fields).every((f) => f.status === "unverified"),
        name,
      ).toBe(true);
    }
  });

  it("records the links observed in the stage B write run", () => {
    for (const name of ["subscribergroup", "timeline", "history"]) {
      expect(REGISTRY[name]!.world, name).toMatchObject({ granularity: "1", status: "verified" });
    }
    expect(REGISTRY.history!.parents[0]).toMatchObject({
      field: "timelines",
      granularity: "2",
      status: "verified",
    });
    expect(REGISTRY.category!.parents[0]).toMatchObject({
      field: "parent",
      granularity: "2",
      status: "verified",
    });
  });

  it("has no draft or visibility fields where World Anvil has none", () => {
    for (const name of ["timeline", "history", "category"])
      expect(REGISTRY[name]!.fields, name).not.toHaveProperty("isDraft");
    expect(REGISTRY.subscribergroup!.fields).not.toHaveProperty("state");
    expect(REGISTRY.subscribergroup!.fields).not.toHaveProperty("isDraft");
  });

  it("marks every probed template field verified, with kinds confirmed only where a value was seen", () => {
    const templates = REGISTRY.article!.templates!;
    const probe = LIVE_OBSERVED.article!.templates!;
    for (const name of ["person", "organization", "settlement", "rank"]) {
      const t = templates[name]!;
      expect(t.probed, name).toBe(true);
      expect(Object.keys(t.fields).sort(), name).toEqual([...probe[name]!.fields].sort());
      for (const [f, d] of Object.entries(t.fields)) {
        expect(d.status, `${name}.${f}`).toBe("verified");
        expect(d.kindConfirmed, `${name}.${f}`).toBe(f in probe[name]!.kinds ? true : false);
      }
    }
    expect(Object.keys(templates.person!.fields)).toHaveLength(123);
    expect(templates.person!.fields.organization).toMatchObject({
      kind: "ref",
      refType: "article",
      kindConfirmed: true,
    });
    expect(templates.person!.fields.portrait).toMatchObject({
      kind: "ref",
      refType: "image",
      kindConfirmed: true,
    });
    expect(templates.organization!.fields.type).toMatchObject({ refType: "internal" });
    expect(templates.location!.probed).toBe(false);
  });

  it("records the world links observed live at their granularity", () => {
    expect(REGISTRY.article!.world).toMatchObject({ granularity: "1", status: "verified" });
    expect(REGISTRY.category!.world).toMatchObject({ granularity: "2", status: "verified" });
    expect(REGISTRY.secret!.world).toMatchObject({ granularity: "2", status: "verified" });
    expect(REGISTRY.secret!.parents[0]).toMatchObject({
      field: "article",
      granularity: "2",
      status: "verified",
    });
  });

  it("only observes fields that exist in the registry", () => {
    for (const [t, o] of Object.entries(LIVE_OBSERVED)) {
      for (const f of o.fields) expect(REGISTRY[t]!.fields[f], `${t}.${f}`).toBeDefined();
    }
  });

  it("wa_describe lists types and details one type and one template", async () => {
    const { call } = await connect();
    const all = await call("wa_describe");
    expect(all.text).toMatch(/not created or deleted/);
    expect(all.text).toContain('"type": "history"');
    const cat = await call("wa_describe", { type: "category" });
    expect(cat.text).toContain("parentCategory");
    const tpl = await call("wa_describe", { type: "article", template: "organization" });
    expect(tpl.text).toContain("internal type ID");
    const bad = await call("wa_describe", { type: "secret", template: "person" });
    expect(bad.isError).toBe(true);
  });
});
