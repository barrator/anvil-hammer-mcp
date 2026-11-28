import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeWorldAnvil, seedData } from "./helpers/fake-wa.js";
import { connect } from "./helpers/setup.js";

const EDIT_WORLD = "world-edit-0003"; // edit_only
const FULL_WORLD = "world-full-0004"; // full_edit
const RO_WORLD = "world-open-0001"; // unlisted → read_only
const writes = (calls: { method: string }[]) =>
  calls.filter((c) => ["PUT", "PATCH", "DELETE"].includes(c.method));
const lastPut = (calls: { method: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === "PUT").at(-1)?.body as Record<string, unknown>;

/** Recursively list backup files. */
function backupFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((p) => p.endsWith(".json") && statSync(p).isFile());
}

describe("safe defaults", () => {
  it("creates articles private and draft unless asked otherwise", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "New Person",
      template: "person",
    });
    expect(r.isError, r.text).toBe(false);
    expect(lastPut(fake.calls)).toMatchObject({
      state: "private",
      isDraft: true,
      templateType: "person",
      world: { id: EDIT_WORLD },
    });
    expect(r.text).toMatch(/Safe defaults applied: state=private, isDraft=true/);
  });

  it("makes an article public only when explicitly asked", async () => {
    const { call, fake } = await connect();
    await call("wa_create_article", { world_id: EDIT_WORLD, title: "Public One", state: "public" });
    expect(lastPut(fake.calls)).toMatchObject({ state: "public", isDraft: true });
    const viaGeneric = await call("wa_create", {
      type: "secret",
      data: { title: "S", world: { id: EDIT_WORLD } },
    });
    expect(viaGeneric.isError, viaGeneric.text).toBe(false);
    expect(lastPut(fake.calls)).toMatchObject({ state: "private", isDraft: true });
  });

  it("applies only the defaults a type supports", async () => {
    const { call, fake } = await connect();
    await call("wa_create", {
      type: "subscribergroup",
      data: { title: "Players", world: { id: EDIT_WORLD } },
    });
    const sg = lastPut(fake.calls);
    expect(sg).not.toHaveProperty("state");
    expect(sg).not.toHaveProperty("isDraft");
    for (const type of ["timeline", "history", "category"]) {
      await call("wa_create", { type, data: { title: `A ${type}`, world: { id: EDIT_WORLD } } });
      const body = lastPut(fake.calls);
      expect(body.state, type).toBe("private");
      expect(body, type).not.toHaveProperty("isDraft");
    }
  });

  it("an update never touches state unless asked", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", fields: { content: "New text." } });
    const patch = fake.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ content: "New text." });
  });
});

describe("field validation", () => {
  it("refuses unknown fields of a probed template before any call, listing known fields", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "P",
      template: "person",
      fields: { nickname: "ok", favouriteColour: "blue" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown field\(s\) for article template "person": favouriteColour/);
    expect(r.text).toMatch(/Known fields: .*nickname/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses unknown fields on an update of a probed template", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { notAField: "x" },
    });
    expect(r.isError).toBe(true);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("accepts fields of a template never probed, with a clear warning", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "Place",
      template: "species",
      fields: { lifespan: "long" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("template not probed yet, fields unverified, check the read-back");
  });

  it("generic tools warn on unknown fields instead of refusing", async () => {
    const { call } = await connect();
    const r = await call("wa_create", {
      type: "category",
      data: { title: "C", world: { id: EDIT_WORLD }, custom2: "x" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/custom2: unknown to the registry, check the read-back/);
  });

  it("drops computed fields with a warning", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create", {
      type: "category",
      data: { title: "C", world: { id: EDIT_WORLD }, url: "https://x" },
    });
    expect(r.text).toMatch(/"url" is computed by World Anvil and was not sent/);
    expect(lastPut(fake.calls)).not.toHaveProperty("url");
  });
});

describe("links and references", () => {
  it("sends links as {id} objects", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "Member",
      template: "person",
      links: { organization: "article-edit-0002", organizations: ["article-edit-0002"] },
      category_id: "category-edit-0001",
    });
    expect(r.isError, r.text).toBe(false);
    expect(lastPut(fake.calls)).toMatchObject({
      organization: { id: "article-edit-0002" },
      organizations: [{ id: "article-edit-0002" }],
      category: { id: "category-edit-0001" },
    });
  });

  it("refuses links to another world, without writing", async () => {
    const { call, fake } = await connect();
    for (const target of ["article-open-0001", "article-blocked-0001"]) {
      const r = await call("wa_create_article", {
        world_id: EDIT_WORLD,
        title: "X",
        template: "person",
        links: { organization: target },
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not in the same world/);
      expect(r.text).not.toMatch(/Hidden/);
    }
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses a link on a non-link field and image references", async () => {
    const { call, fake } = await connect();
    const a = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "X",
      template: "person",
      links: { nickname: "article-edit-0002" },
    });
    expect(a.text).toMatch(/"nickname" is not a link field/);
    const b = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "X",
      template: "person",
      links: { portrait: "image-0001" },
    });
    expect(b.text).toMatch(/image references cannot be checked/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses to move an element to another world", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update", {
      type: "article",
      id: "article-edit-0001",
      data: { world: { id: FULL_WORLD } },
    });
    expect(r.text).toMatch(/cannot be moved to another world/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses to create a world", async () => {
    const { call } = await connect();
    const r = await call("wa_create", { type: "world", data: { title: "New World" } });
    expect(r.text).toMatch(/worlds cannot be created/);
  });
});

describe("read-back verification", () => {
  it("reports fields World Anvil accepted but did not store", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "Guild",
      template: "organization",
      fields: { type: "Family", motto: "Invented motto" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/WARNING: World Anvil accepted but did NOT store: type/);
    expect(r.text).toMatch(/Stored: .*motto/);
  });

  it("reports an update that changed nothing as ignored", async () => {
    const { call } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0002" });
    const r = await call("wa_update_article", {
      id: "article-edit-0002",
      fields: { type: "Guild" },
    });
    expect(r.text).toMatch(/did NOT store: type/);
  });

  it("returns id, editor URL and state from the read-back, marked untrusted", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "P",
      template: "person",
    });
    expect(r.text).toMatch(/<untrusted_world_content source="article:created-article-\d+">/);
    expect(r.text).toContain('"editURL"');
    expect(r.text).toContain('"state": "private"');
  });
});

describe("dry run", () => {
  it("shows exactly what would be sent and writes nothing", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "Dry",
      template: "person",
      fields: { nickname: "n" },
      dry_run: true,
    });
    expect(r.text).toMatch(/Dry run: nothing was written/);
    expect(r.text).toContain('"method": "PUT"');
    expect(r.text).toContain('"isDraft": true');
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("does not take a backup", async () => {
    const { call, config } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
      dry_run: true,
    });
    expect(backupFiles(config.backupDir)).toHaveLength(0);
  });
});

describe("conflict detection", () => {
  it("refuses to update an element never read in the session", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
    });
    expect(r.text).toMatch(/has not been read in this session. Read it first with wa_get/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses when someone else changed the element since it was read", async () => {
    const shared = createFakeWorldAnvil(seedData());
    const alice = await connect({ shared });
    const bob = await connect({ shared });
    await alice.call("wa_get", { type: "article", id: "article-edit-0001" });
    await bob.call("wa_get", { type: "article", id: "article-edit-0001" });
    const b = await bob.call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Bob's text." },
    });
    expect(b.isError, b.text).toBe(false);
    const a = await alice.call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Alice's text." },
    });
    expect(a.isError).toBe(true);
    expect(a.text).toMatch(/was changed by someone else since you last read it/);
    expect(a.text).toMatch(/Read it again with wa_get/);
    expect(shared.data.articles.find((x) => x.id === "article-edit-0001")!.content).toBe(
      "Bob's text.",
    );
  });

  it("uses expected_update_date when given", async () => {
    const { call } = await connect();
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
      expected_update_date: "1999-01-01 00:00:00.000000",
    });
    expect(r.text).toMatch(/changed by someone else/);
    const ok = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
      expected_update_date: "2026-07-01 10:00:00.000000",
    });
    expect(ok.isError, ok.text).toBe(false);
  });

  it("allows successive writes: the read-back refreshes the remembered date", async () => {
    const { call } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    expect(
      (await call("wa_update_article", { id: "article-edit-0001", fields: { content: "1" } }))
        .isError,
    ).toBe(false);
    expect(
      (await call("wa_update_article", { id: "article-edit-0001", fields: { content: "2" } }))
        .isError,
    ).toBe(false);
  });
});

describe("backups", () => {
  it("saves the full element before an update, owner-only", async () => {
    const { call, config } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Changed." },
    });
    expect(r.text).toMatch(/Backup saved before the change: \d{8}T\d{9}Z-[a-z0-9]{6}-update\.json/);
    const files = backupFiles(config.backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(join(EDIT_WORLD, "article", "article-edit-0001"));
    const saved = JSON.parse(readFileSync(files[0]!, "utf8"));
    expect(saved).toMatchObject({
      type: "article",
      id: "article-edit-0001",
      worldId: EDIT_WORLD,
      reason: "update",
      granularity: "2",
    });
    expect(saved.element.content).toBe("Original invented content.");
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600);
  });

  it("refuses the write when the backup cannot be saved", async () => {
    const { call, fake, config } = await connect();
    writeFileSync(join(config.backupDir, EDIT_WORLD), "a file where a folder should be");
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not save the backup.*Nothing was written/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("removes backups older than the retention period", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { call, config } = await connect({ now: () => now, config: { backupRetentionDays: 90 } });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", fields: { content: "a" } });
    now = new Date("2026-03-01T00:00:00Z"); // 59 days later: kept
    await call("wa_update_article", { id: "article-edit-0001", fields: { content: "b" } });
    expect(backupFiles(config.backupDir)).toHaveLength(2);
    now = new Date("2026-04-15T00:00:00Z"); // 104 days after the first
    await call("wa_update_article", { id: "article-edit-0001", fields: { content: "c" } });
    const names = backupFiles(config.backupDir).map((f) => f.split("/").at(-1));
    expect(names).toHaveLength(2);
    expect(names.some((n) => n!.startsWith("20260101"))).toBe(false);
  });
});

describe("restore", () => {
  it("lists backups and puts a modified element back exactly", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Changed.", nickname: "" },
    });
    const list = await call("wa_restore", { type: "article", id: "article-edit-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    const r = await call("wa_restore", {
      type: "article",
      id: "article-edit-0001",
      backup_id: backupId,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/^\[anvil-hammer-mcp\] Restored article/);
    const el = fake.data.articles.find((x) => x.id === "article-edit-0001")!;
    expect(el.content).toBe("Original invented content.");
    expect(el.nickname).toBe("Original nickname");
    expect(r.text).toMatch(/-restore\.json/); // the restore itself was backed up first
  });

  it("is conflict-checked like any write", async () => {
    const shared = createFakeWorldAnvil(seedData());
    const a = await connect({ shared });
    await a.call("wa_get", { type: "article", id: "article-edit-0001" });
    await a.call("wa_update_article", { id: "article-edit-0001", fields: { content: "Changed." } });
    shared.data.articles.find((x) => x.id === "article-edit-0001")!.updateDate = {
      date: "2030-01-01 00:00:00.000000",
    };
    const list = await a.call("wa_restore", { type: "article", id: "article-edit-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    const r = await a.call("wa_restore", {
      type: "article",
      id: "article-edit-0001",
      backup_id: backupId,
    });
    expect(r.text).toMatch(/changed by someone else/);
  });
});

describe("delete", () => {
  it("is not exposed with the default configuration", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("wa_delete");
    expect(names).toEqual(
      expect.arrayContaining([
        "wa_create",
        "wa_update",
        "wa_create_article",
        "wa_update_article",
        "wa_restore",
      ]),
    );
  });

  it("is refused outside full_edit worlds", async () => {
    const { call, fake } = await connect({ config: { enableDelete: true } });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const edit = await call("wa_delete", { type: "article", id: "article-edit-0001" });
    expect(edit.text).toMatch(
      /deleting requires a full_edit world; this element's world is edit_only/,
    );
    await call("wa_get", { type: "article", id: "article-open-0001" });
    const ro = await call("wa_delete", { type: "article", id: "article-open-0001" });
    expect(ro.text).toMatch(/read_only/);
    const blocked = await call("wa_delete", { type: "article", id: "article-blocked-0001" });
    expect(blocked.text).toMatch(/Not found/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("backs up first, and restore recreates the element with a new ID and lists its links", async () => {
    const { call, fake, config } = await connect({ config: { enableDelete: true } });
    await call("wa_get", { type: "article", id: "article-full-0001" });
    const d = await call("wa_delete", { type: "article", id: "article-full-0001" });
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toMatch(/-delete\.json/);
    expect(backupFiles(config.backupDir)).toHaveLength(1);
    expect(fake.data.articles.some((a) => a.id === "article-full-0001")).toBe(false);

    const list = await call("wa_restore", { type: "article", id: "article-full-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    const r = await call("wa_restore", {
      type: "article",
      id: "article-full-0001",
      backup_id: backupId,
      scan_links: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/Recreated article "created-article-\d+"/);
    expect(r.text).toMatch(/NEW ID/);
    expect(r.text).toContain('"oldId": "article-full-0001"');
    expect(r.text).toMatch(/"field": "category"/);
    expect(r.text).toContain('"id": "article-full-0002"'); // scan found the article mentioning the old ID
    const recreated = fake.data.articles.find((a) => a.title === "Deletable Article")!;
    expect(recreated.content).toBe("Invented content to delete.");
  });
});

describe("access levels for writes", () => {
  it("refuses writes in read_only worlds and hides blocked ones", async () => {
    const { call, fake } = await connect();
    const ro = await call("wa_create_article", { world_id: RO_WORLD, title: "X" });
    expect(ro.text).toMatch(/world is read_only; writes need full_edit or edit_only/);
    const bl = await call("wa_create_article", { world_id: "world-blocked-0002", title: "X" });
    expect(bl.text).toContain('Not found: world "world-blocked-0002"');
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("refuses writes through a child element of a read_only world", async () => {
    const { call, fake } = await connect();
    // A secret created with no world, attached to an article of the read_only world.
    const r = await call("wa_create", {
      type: "secret",
      data: { title: "S", article: { id: "article-open-0001" } },
    });
    expect(r.text).toMatch(/read_only/);
    await call("wa_get", { type: "history", id: "history-open-0001" });
    const h = await call("wa_update", {
      type: "history",
      id: "history-open-0001",
      data: { content: "x" },
    });
    expect(h.text).toMatch(/read_only/);
    const s = await call("wa_update", {
      type: "secret",
      id: "secret-blocked-0001",
      data: { content: "x" },
    });
    expect(s.text).toMatch(/Not found/);
    expect(writes(fake.calls)).toHaveLength(0);
  });

  it("resolves a new element's world from its parent when no world is given", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create", {
      type: "secret",
      data: { title: "S", article: { id: "article-edit-0001" } },
    });
    expect(r.isError, r.text).toBe(false);
    expect(lastPut(fake.calls)).toMatchObject({ world: { id: EDIT_WORLD } });
  });
});

describe("elements without updateDate", () => {
  const opts = { fake: { noUpdateDate: ["subscribergroup"] }, config: { enableDelete: true } };

  async function withGroup() {
    const c = await connect({ ...opts, config: { ...opts.config } });
    const r = await c.call("wa_create", {
      type: "subscribergroup",
      data: { title: "Players", world: { id: FULL_WORLD } },
    });
    const id = /source="subscribergroup:([^"]+)"/.exec(r.text)![1]!;
    return { ...c, id };
  }

  it("can be updated and deleted after a read: conflict check compares content", async () => {
    const { call, id } = await withGroup();
    await call("wa_get", { type: "subscribergroup", id });
    const u = await call("wa_update", {
      type: "subscribergroup",
      id,
      data: { description: "Invented." },
    });
    expect(u.isError, u.text).toBe(false);
    const d = await call("wa_delete", { type: "subscribergroup", id });
    expect(d.isError, d.text).toBe(false);
  });

  it("refuses when the content changed since the read", async () => {
    const { call, fake, id } = await withGroup();
    await call("wa_get", { type: "subscribergroup", id });
    fake.data.subscribergroups.find((g) => g.id === id)!.title = "Renamed by someone else";
    const r = await call("wa_update", { type: "subscribergroup", id, data: { description: "x" } });
    expect(r.text).toMatch(/changed by someone else since you last read it \(changed: title\)/);
  });

  it("refuses expected_update_date, which cannot be checked", async () => {
    const { call, id } = await withGroup();
    const r = await call("wa_update", {
      type: "subscribergroup",
      id,
      data: { description: "x" },
      expected_update_date: "2026-01-01",
    });
    expect(r.text).toMatch(/has no updateDate/);
  });
});

describe("restore details", () => {
  it("never sends a placeholder {id: -1} or an image reference", async () => {
    const data = seedData();
    const el = data.articles.find((a) => a.id === "article-edit-0001")!;
    el.cover = { id: -1 };
    el.portrait = { id: "image-fake-0001", url: "https://fake.invalid/i.png" };
    const { call, fake } = await connect({ data });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", fields: { content: "Changed." } });
    el.portrait = { id: "image-fake-0002" }; // changed on the site meanwhile (no updateDate bump needed for the test)
    const list = await call("wa_restore", { type: "article", id: "article-edit-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_restore", {
      type: "article",
      id: "article-edit-0001",
      backup_id: backupId,
    });
    const patch = fake.calls.filter((c) => c.method === "PATCH").at(-1)!.body!;
    expect(patch).not.toHaveProperty("cover");
    expect(patch).not.toHaveProperty("portrait");
    expect(r.text).not.toMatch(/did NOT store: .*cover/);
    expect(r.text).toMatch(/Image references are not restored.*portrait/);
  });

  it("restores a public element as private unless restore_public is given", async () => {
    const data = seedData();
    data.articles.find((a) => a.id === "article-full-0001")!.state = "public";
    const { call, fake } = await connect({ data, config: { enableDelete: true } });
    await call("wa_get", { type: "article", id: "article-full-0001" });
    await call("wa_delete", { type: "article", id: "article-full-0001" });
    const list = await call("wa_restore", { type: "article", id: "article-full-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;

    const dry = await call("wa_restore", {
      type: "article",
      id: "article-full-0001",
      backup_id: backupId,
      dry_run: true,
    });
    expect(dry.text).toContain('"state": "private"');
    expect(dry.text).toMatch(/restored as PRIVATE/);

    const pub = await call("wa_restore", {
      type: "article",
      id: "article-full-0001",
      backup_id: backupId,
      restore_public: true,
    });
    expect(pub.isError, pub.text).toBe(false);
    expect(lastPut(fake.calls)).toMatchObject({ state: "public" });
  });

  it("does not make an existing element public again without restore_public", async () => {
    const data = seedData();
    const el = data.articles.find((a) => a.id === "article-edit-0001")!;
    el.state = "public";
    const { call, fake } = await connect({ data });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", state: "private" });
    const list = await call("wa_restore", { type: "article", id: "article-edit-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    const r = await call("wa_restore", {
      type: "article",
      id: "article-edit-0001",
      backup_id: backupId,
    });
    expect(r.text).toMatch(/restored as PRIVATE/);
    expect(fake.data.articles.find((a) => a.id === "article-edit-0001")!.state).toBe("private");
  });
});
