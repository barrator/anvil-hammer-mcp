import { describe, expect, it } from "vitest";
import { REGISTRY, scopeOf } from "../src/registry/index.js";
import { LIVE_OBSERVED } from "../src/registry/observed.js";
import { connect } from "./helpers/setup.js";

describe("registry", () => {
  it("covers every element type of the spec, plus eras", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        "article",
        "block",
        "blockfolder",
        "blocktemplate",
        "blocktemplatepart",
        "canvas",
        "category",
        "chronicle",
        "era",
        "history",
        "image",
        "layer",
        "manuscript",
        "manuscript_beat",
        "manuscript_bookmark",
        "manuscript_label",
        "manuscript_part",
        "manuscript_plot",
        "manuscript_stat",
        "manuscript_tag",
        "manuscript_version",
        "map",
        "marker",
        "markergroup",
        "markertype",
        "note",
        "notebook",
        "notesection",
        "rpgsystem",
        "secret",
        "subscribergroup",
        "timeline",
        "user",
        "variable",
        "variablecollection",
        "world",
      ].sort(),
    );
  });

  /** Walk a type's parent chain: does it reach something with a world link? */
  const reachesWorld = (name: string, seen = new Set<string>()): boolean => {
    const t = REGISTRY[name]!;
    if (t.world) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return t.parents.some((p) => reachesWorld(p.type, seen));
  };

  it.each(Object.values(REGISTRY))("$name is internally consistent", (t) => {
    expect(t.granularities).toContain(t.defaultGranularity);
    expect(t.granularities).toContain(t.backupGranularity);
    if (t.world) expect(t.granularities).toContain(t.world.granularity);
    expect(["verified", "unverified"]).toContain(t.status);
    for (const p of t.parents) {
      expect(REGISTRY[p.type], `parent type ${p.type}`).toBeDefined();
      expect(t.granularities).toContain(p.granularity);
      expect(t.fields[p.field], `parent field ${p.field}`).toBeDefined();
    }
    const scope = scopeOf(t);
    if (t.list) {
      const pt = t.list.parentType;
      expect(pt === "none" || pt === "user" || REGISTRY[pt] !== undefined, pt).toBe(true);
      expect(t.verbs).toContain("list");
      expect(t.list.path).toMatch(/^[a-z_]+(\/[a-z_]+)?$/);
    }
    if (scope === "world" && t.name !== "world" && t.verbs.length > 0) {
      expect(reachesWorld(t.name), "needs a way to reach its world").toBe(true);
      // Its list parent is a world element too, so lists can be access-checked.
      if (t.list) expect(scopeOf(REGISTRY[t.list.parentType]!)).toBe("world");
    }
    if (scope !== "world") {
      // Account data and shared lists are read-only here.
      expect(t.verbs.filter((v) => v !== "get" && v !== "list")).toEqual([]);
    }
    for (const [name, f] of Object.entries(t.fields)) {
      expect(["verified", "unverified"], name).toContain(f.status);
      if (f.bbcode) expect(f.kind, name).toBe("string");
      if (f.refType && f.refType !== "internal" && REGISTRY[f.refType] === undefined) {
        // Links to unregistered types are refused on writes; they must not be required.
        expect(f.requiredOnCreate, name).not.toBe(true);
      }
      if (f.hidden) expect(f.writable, `${name} hidden fields are never sent`).toBe(false);
    }
    for (const [k] of Object.entries(t.createDefaults ?? {}))
      expect(t.fields[k], `default for ${k}`).toBeDefined();
    expect(t.path).toMatch(/^[a-z_]+$/);
  });

  it("keeps account data and shared lists read-only, and knows what the API could do", () => {
    for (const name of ["user", "blocktemplate", "blocktemplatepart"])
      expect(scopeOf(REGISTRY[name]!), name).toBe("account");
    for (const name of ["markertype", "rpgsystem"])
      expect(scopeOf(REGISTRY[name]!), name).toBe("catalog");
    expect(REGISTRY.user!.verbs).toEqual(["get"]);
    expect(REGISTRY.user!.apiVerbs).toContain("update");
    expect(REGISTRY.blocktemplate!.list).toEqual({
      path: "user/blocktemplates",
      parentType: "user",
    });
    expect(REGISTRY.markertype!.list?.parentType).toBe("none");
  });

  it("knows the quirks: images never created, eras without a route, notes typed by default", () => {
    expect(REGISTRY.image!.verbs).not.toContain("create");
    expect(REGISTRY.era!.verbs).toEqual([]);
    expect(REGISTRY.era!.quirks.join(" ")).toMatch(/No API route/);
    expect(REGISTRY.timeline!.fields.eras).toMatchObject({ refType: "era", writable: false });
    expect(REGISTRY.note!.createDefaults).toEqual({ type: "default" });
    expect(REGISTRY.variablecollection!.path).toBe("variablecollection");
    expect(REGISTRY.variablecollection!.quirks.join(" ")).toMatch(/variable_collection/);
    expect(REGISTRY.map!.fields.image).toMatchObject({ refType: "image", requiredOnCreate: true });
  });

  it("hides rendered duplicates and the profile's secrets", () => {
    expect(REGISTRY.history!.fields.parsedContent).toMatchObject({ hidden: true, writable: false });
    for (const f of ["token", "email", "discordToken", "discordRefreshToken", "dob"])
      expect(REGISTRY.user!.fields[f], f).toMatchObject({ hidden: true });
    expect(REGISTRY.user!.outputAllowlist).toBe(true);
  });

  it("records the owner's timeline and event observations, unverified until a live run", () => {
    const h = REGISTRY.history!.fields;
    expect(h.lane).toMatchObject({ kind: "string", status: "unverified", source: "notes" });
    expect(h.year!.kind).toBe("string");
    for (const k of ["month", "day", "hour", "minute"]) expect(h[k]!.kind, k).toBe("integer");
    const t = REGISTRY.timeline!.fields;
    // timeline.type was already observed live (stage B); the others wait for the E1 report.
    expect(t.type!.status).toBe("verified");
    for (const k of ["version", "displayRenderType", "showInToc", "allowComments"])
      expect(t[k]!.status, k).toBe("unverified");
  });

  it("marks the spec-only types unverified, and the types seen live verified", () => {
    for (const name of [
      "world",
      "article",
      "category",
      "secret",
      "subscribergroup",
      "timeline",
      "history",
    ])
      expect(REGISTRY[name]!.status, name).toBe("verified");
    for (const name of ["map", "note", "image", "chronicle", "user", "era"])
      expect(REGISTRY[name]!.status, name).toBe("unverified");
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

  it("keeps unverified exactly the fields no live run has observed", () => {
    const unverified = (name: string) =>
      Object.entries(REGISTRY[name]!.fields)
        .filter(([, f]) => f.status !== "verified")
        .map(([k]) => k)
        .sort();
    expect(unverified("subscribergroup")).toEqual([]);
    expect(unverified("category")).toEqual([]);
    // Stage E additions (names from stage B or the owner's reads) wait for the E1 live report.
    expect(unverified("timeline")).toEqual(
      [
        "allowComments",
        "almanac",
        "author",
        "backgroundImage",
        "calendar",
        "cover",
        "displayCenterYear",
        "displayCss",
        "displayRenderType",
        "eras",
        "likes",
        "presentationParameters",
        "showInToc",
        "utdOffset",
        "version",
        "views",
      ].sort(),
    );
    expect(unverified("history")).toContain("lane");
    expect(unverified("history")).toContain("characters");
  });

  it("knows the history fields wa_upsert_timeline_event will need, as links where they link", () => {
    const f = REGISTRY.history!.fields;
    for (const k of ["hour", "minute", "endingHour", "endingMinute"]) expect(f[k], k).toBeDefined();
    for (const k of ["location", "species", "report", "militaryConflict"]) {
      expect(f[k], k).toMatchObject({ kind: "ref", refType: "article", kindConfirmed: false });
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
