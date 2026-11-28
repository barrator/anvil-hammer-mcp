/** Stage E: new types, account and catalog data, upsert tools, tool groups. Offline. */
import { describe, expect, it } from "vitest";
import { ConfigError, parseTools } from "../src/config/index.js";
import { mergeLane, parseLane } from "../src/tools/upsert.js";
import { seedData } from "./helpers/fake-wa.js";
import { connect, untrustedJson } from "./helpers/setup.js";

const EDIT_WORLD = "world-edit-0003";
const OPEN_WORLD = "world-open-0001";
type Calls = { method: string; path: string; query: Record<string, string>; body?: unknown }[];
const writes = (calls: Calls) => calls.filter((c) => ["PUT", "PATCH", "DELETE"].includes(c.method));

function withGroupsAndTimelines() {
  const data = seedData();
  data.subscribergroups.push(
    { id: "group-edit-0001", title: "Invented Players", world: { id: EDIT_WORLD } },
    { id: "group-open-0001", title: "Other Players", world: { id: OPEN_WORLD } },
  );
  data.timelines.push(
    {
      id: "timeline-edit-0001",
      title: "Invented Parallel Timeline",
      type: "parallel",
      world: { id: EDIT_WORLD },
    },
    { id: "timeline-edit-0002", title: "Second Timeline", world: { id: EDIT_WORLD } },
  );
  data.histories.push({
    id: "history-edit-0001",
    title: "Invented Event",
    world: { id: EDIT_WORLD },
    timelines: [{ id: "timeline-edit-0001" }, { id: "timeline-edit-0002" }],
    lane: '{"timeline-edit-0001":2,"timeline-edit-0002":4}',
    year: "10",
    parsedContent: "<p>Rendered invented HTML</p>",
    updateDate: { date: "2026-08-10 10:00:00.000000", timezone_type: 3, timezone: "UTC" },
  });
  return data;
}

describe("account data and shared lists", () => {
  it("shows your own profile without tokens, personal details or unregistered fields", async () => {
    const { call } = await connect();
    const r = await call("wa_get", { type: "user", id: "user-fake-0001" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("read-only through this server");
    const shown = untrustedJson(r.text) as Record<string, unknown>;
    expect(shown.username).toBe("fake-user");
    for (const f of ["token", "email", "discordRefreshToken", "someNewField"])
      expect(shown, f).not.toHaveProperty(f);
    expect(r.text).not.toContain("fake-profile-token");
  });

  it("refuses another user's profile without calling World Anvil for it", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_get", { type: "user", id: "user-someone-else" });
    expect(r.text).toMatch(/Not found/);
    expect(fake.calls.some((c) => c.path === "user")).toBe(false);
  });

  it("lists block templates of your account and shared lists without a parent", async () => {
    const { call, fake } = await connect();
    const t = await call("wa_list", { type: "blocktemplate" });
    expect(t.isError, t.text).toBe(false);
    expect(t.text).toContain("Invented Template");
    expect(fake.calls.find((c) => c.path === "user/blocktemplates")?.query.id).toBe(
      "user-fake-0001",
    );
    const parts = await call("wa_list", {
      type: "blocktemplatepart",
      parent_id: "blocktemplate-0001",
    });
    expect(parts.text).toContain("Invented Part");
    const pins = await call("wa_list", { type: "markertype" });
    expect(pins.text).toContain("Invented Pin");
    expect(pins.text).not.toContain("Hidden Pin"); // names a blocked world
    const sys = await call("wa_list", { type: "rpgsystem" });
    expect(sys.text).toContain("Invented System");
  });

  it("hides a shared element that names a blocked world", async () => {
    const { call } = await connect();
    const r = await call("wa_get", { type: "markertype", id: "markertype-hidden-0001" });
    expect(r.text).toMatch(/Not found/);
    expect(r.text).not.toContain("Hidden Pin");
  });

  it("keeps account data and shared lists read-only", async () => {
    const { call, fake } = await connect();
    const u = await call("wa_update", { type: "user", id: "user-fake-0001", data: { bio: "x" } });
    expect(u.text).toMatch(/data of your account, not of a world; this server keeps it read-only/);
    const m = await call("wa_create", { type: "markertype", data: { title: "X" } });
    expect(m.text).toMatch(/shared World Anvil list; it is read-only/);
    const b = await call("wa_create", { type: "blocktemplate", data: { title: "X" } });
    expect(b.text).toMatch(/read-only/);
    expect(writes(fake.calls)).toHaveLength(0);
  });
});

describe("new world types", () => {
  it("lists and reads notebook sections and notes through their parent chain", async () => {
    const { call } = await connect();
    const s = await call("wa_list", { type: "notesection", parent_id: "notebook-edit-0001" });
    expect(s.text).toContain("Invented Section");
    const n = await call("wa_list", { type: "note", parent_id: "notesection-edit-0001" });
    expect(n.text).toContain("Invented Note");
    const g = await call("wa_get", { type: "note", id: "note-edit-0001" });
    expect(g.isError, g.text).toBe(false);
    expect(g.text).toContain("Invented note text."); // Markdown view of the BBCode
    expect(g.text).not.toContain("[p]");
  });

  it("asks for the parent of a child list", async () => {
    const { call } = await connect();
    const r = await call("wa_list", { type: "note" });
    expect(r.text).toMatch(/parent_id is required: the notesection/);
  });

  it("creates a note with the undocumented type set by default, private", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create", {
      type: "note",
      data: { title: "New invented note", notesection: { id: "notesection-edit-0001" } },
    });
    expect(r.isError, r.text).toBe(false);
    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("note");
    expect(put.body).toMatchObject({ type: "default", state: "private", isDraft: true });
  });

  it("explains that eras have no route, and that images cannot be created", async () => {
    const { call, fake } = await connect();
    const e = await call("wa_get", { type: "era", id: "era-0001" });
    expect(e.text).toMatch(/Eras cannot be read directly.*eras field/);
    const l = await call("wa_list", { type: "era", parent_id: EDIT_WORLD });
    expect(l.text).toMatch(/Eras cannot be listed/);
    const i = await call("wa_create", {
      type: "image",
      data: { title: "X", world: { id: EDIT_WORLD } },
    });
    expect(i.text).toMatch(/images cannot be created through the API/);
    expect(fake.calls.filter((c) => c.path === "era")).toHaveLength(0);
  });

  it("checks account and shared references by reading them", async () => {
    const { call, fake } = await connect();
    const ok = await call("wa_create", {
      type: "block",
      data: {
        title: "Invented block",
        folder: { id: "blockfolder-edit-0001" },
        template: { id: "blocktemplate-0001" },
        RPGSRD: { id: "rpgsystem-0001" },
      },
    });
    expect(ok.isError, ok.text).toBe(false);
    const bad = await call("wa_create", {
      type: "block",
      data: {
        title: "Invented block",
        folder: { id: "blockfolder-edit-0001" },
        template: { id: "blocktemplate-missing" },
        RPGSRD: { id: "rpgsystem-0001" },
      },
    });
    expect(bad.text).toMatch(
      /links to blocktemplate "blocktemplate-missing", which is not readable/,
    );
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("never shows a timeline event's rendered HTML", async () => {
    const { call } = await connect({ data: withGroupsAndTimelines() });
    const r = await call("wa_get", { type: "history", id: "history-edit-0001", granularity: "2" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain("parsedContent");
    expect(r.text).not.toContain("Rendered invented HTML");
  });
});

describe("wa_upsert_secret", () => {
  it("creates a private secret attached to an article and restricted to a group", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    const r = await call("wa_upsert_secret", {
      world_id: EDIT_WORLD,
      title: "Invented secret",
      content: "Only **players** know.",
      article_id: "article-edit-0001",
      subscriber_group_ids: ["group-edit-0001"],
    });
    expect(r.isError, r.text).toBe(false);
    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("secret");
    expect(put.body).toMatchObject({
      title: "Invented secret",
      world: { id: EDIT_WORLD },
      article: { id: "article-edit-0001" },
      subscribergroups: [{ id: "group-edit-0001" }],
      state: "private",
      content: "[p]Only [b]players[/b] know.[/p]",
    });
  });

  it("refuses an article or a group of another world, before sending", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    const a = await call("wa_upsert_secret", {
      world_id: EDIT_WORLD,
      title: "X",
      article_id: "article-open-0001",
    });
    expect(a.text).toMatch(/not in the same world/);
    const g = await call("wa_upsert_secret", {
      world_id: EDIT_WORLD,
      title: "X",
      subscriber_group_ids: ["group-open-0001"],
    });
    expect(g.text).toMatch(/not in the same world/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("updates only what is given, and [] removes the group restriction", async () => {
    const data = withGroupsAndTimelines();
    data.secrets.push({
      id: "secret-edit-0001",
      title: "Old secret",
      content: "[p]Old.[/p]",
      world: { id: EDIT_WORLD },
      subscribergroups: [{ id: "group-edit-0001" }],
      updateDate: { date: "2026-08-11 10:00:00.000000", timezone_type: 3, timezone: "UTC" },
    });
    const { call, fake } = await connect({ data });
    await call("wa_get", { type: "secret", id: "secret-edit-0001" });
    const r = await call("wa_upsert_secret", {
      id: "secret-edit-0001",
      subscriber_group_ids: [],
      append: { content: "New line." },
    });
    expect(r.isError, r.text).toBe(false);
    const patch = fake.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      subscribergroups: [],
      content: "[p]Old.[/p]\n[p]New line.[/p]",
    });
  });

  it("says what is missing to create, and refuses create-only arguments on update", async () => {
    const { call } = await connect();
    expect((await call("wa_upsert_secret", { title: "X" })).text).toMatch(
      /give world_id and title/,
    );
    expect(
      (await call("wa_upsert_secret", { id: "secret-open-noworld-0001", world_id: EDIT_WORLD }))
        .text,
    ).toMatch(/world_id: only for creating/);
  });
});

describe("wa_upsert_timeline_event", () => {
  it("creates a dated, private event with lanes as JSON keyed by timeline", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    const r = await call("wa_upsert_timeline_event", {
      world_id: EDIT_WORLD,
      title: "Invented battle",
      timelines: [{ id: "timeline-edit-0001", lane: 3 }, { id: "timeline-edit-0002" }],
      start: { year: "-50", month: 3, day: 1, hour: 6, minute: 30 },
      end: { year: "-50", month: 3, day: 2 },
      links: { article: "article-edit-0001", organizations: ["article-edit-0002"] },
      content: "A *short* text.",
    });
    expect(r.isError, r.text).toBe(false);
    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      title: "Invented battle",
      world: { id: EDIT_WORLD },
      timelines: [{ id: "timeline-edit-0001" }, { id: "timeline-edit-0002" }],
      lane: '{"timeline-edit-0001":3}',
      year: "-50",
      month: 3,
      day: 1,
      hour: 6,
      minute: 30,
      endingYear: "-50",
      endingMonth: 3,
      endingDay: 2,
      article: { id: "article-edit-0001" },
      organizations: [{ id: "article-edit-0002" }],
      state: "private",
    });
  });

  it("requires a year for an end, and deduces nothing", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    const r = await call("wa_upsert_timeline_event", {
      world_id: EDIT_WORLD,
      title: "X",
      timelines: [{ id: "timeline-edit-0001" }],
      start: { year: "10" },
      end: { month: 4 },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/year/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses a timeline or an article of another world, and asks for what a create needs", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    const t = await call("wa_upsert_timeline_event", {
      world_id: EDIT_WORLD,
      title: "X",
      timelines: [{ id: "timeline-open-0001" }],
      start: { year: "10" },
    });
    expect(t.text).toMatch(/not in the same world/);
    const m = await call("wa_upsert_timeline_event", { world_id: EDIT_WORLD, title: "X" });
    expect(m.text).toMatch(/give world_id, title, timelines and start/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("on update, keeps the lanes of timelines kept, drops removed ones, sets the given ones", async () => {
    const { call, fake } = await connect({ data: withGroupsAndTimelines() });
    await call("wa_get", { type: "history", id: "history-edit-0001" });
    const r = await call("wa_upsert_timeline_event", {
      id: "history-edit-0001",
      timelines: [{ id: "timeline-edit-0001", lane: 7 }],
    });
    expect(r.isError, r.text).toBe(false);
    const patch = fake.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      timelines: [{ id: "timeline-edit-0001" }],
      lane: '{"timeline-edit-0001":7}',
    });
  });

  it("merges lanes as JSON and refuses a lane value it cannot read", () => {
    expect(parseLane('{"a":1,"b":"2"}')).toEqual({ a: 1, b: 2 });
    expect(parseLane("")).toEqual({});
    expect(parseLane("not json")).toBeUndefined();
    expect(mergeLane('{"a":1,"b":2}', [{ id: "a" }, { id: "b" }])).toEqual({});
    expect(mergeLane('{"a":1,"b":2}', [{ id: "a" }, { id: "c", lane: 5 }])).toEqual({
      lane: '{"a":1,"c":5}',
    });
    expect(() => mergeLane("[1,2]", [{ id: "a", lane: 1 }])).toThrow(/not in the expected form/);
  });
});

describe("tool groups (WA_TOOLS)", () => {
  const names = async (tools: ReadonlySet<string> | undefined, enableDelete = false) => {
    const { client } = await connect({ config: { tools, enableDelete } });
    return (await client.listTools()).tools.map((t) => t.name).sort();
  };

  it("full exposes every tool (delete only when enabled); essential exposes 8", async () => {
    expect(await names(undefined)).toHaveLength(12);
    expect(await names(undefined, true)).toHaveLength(13);
    const essential = await names(parseTools("essential", false));
    expect(essential).toEqual(
      [
        "wa_create_article",
        "wa_describe",
        "wa_get",
        "wa_list",
        "wa_list_articles",
        "wa_list_worlds",
        "wa_restore",
        "wa_update_article",
      ].sort(),
    );
    expect(await names(parseTools("wa_get, wa_upsert_secret", false))).toEqual([
      "wa_get",
      "wa_upsert_secret",
    ]);
  });

  it("refuses unknown names, and wa_delete without WA_ENABLE_DELETE", () => {
    expect(parseTools(undefined, false)).toBeUndefined();
    expect(parseTools("full", false)).toBeUndefined();
    expect(() => parseTools("wa_get,wa_nope", false)).toThrow(ConfigError);
    expect(() => parseTools("wa_get,wa_nope", false)).toThrow(/unknown tool\(s\) wa_nope/);
    expect(() => parseTools("wa_delete", false)).toThrow(/WA_ENABLE_DELETE/);
    expect(parseTools("wa_delete", true)).toEqual(new Set(["wa_delete"]));
  });
});

describe("wa_describe", () => {
  it("says which types are unverified, that eras have no route, and what is read-only", async () => {
    const { call } = await connect();
    const all = await call("wa_describe");
    expect(all.text).toMatch(/Not verified by a live test yet .*map/);
    expect(all.text).toMatch(/Eras have no API route/);
    expect(all.text).toMatch(/are read-only here/);
    const map = await call("wa_describe", { type: "map" });
    expect(map.text).toMatch(/map is not verified by a live test yet/);
    const user = await call("wa_describe", { type: "user" });
    expect(user.text).toMatch(/Account data/);
    expect(user.text).toContain('"scope": "account"');
    const article = await call("wa_describe", { type: "article" });
    expect(article.text).not.toMatch(/not verified by a live test yet/);
  });
});
