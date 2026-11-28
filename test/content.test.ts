import { describe, expect, it } from "vitest";
import { seedData } from "./helpers/fake-wa.js";
import { connect, untrustedJson } from "./helpers/setup.js";

const U = "0a1b2c3d-1111-2222-3333-444455556666";
const EDIT_WORLD = "world-edit-0003";
const NBSP = " ";

/** article-edit-0001 (edit_only world) with editor-style content. */
function withContent(content: string, extra: Record<string, unknown> = {}) {
  const data = seedData();
  Object.assign(
    data.articles.find((a) => a.id === "article-edit-0001")!,
    { content, ...extra },
  );
  return data;
}

const EDITOR = `[h1|${U}]Titre[/h1]\n[p]Couleur principale${NBSP}: Gueules[br]Couleur secondaire${NBSP}: Sable[/p]\n[p][/p]\n[p]Voir @[Orin](Article:article-edit-0002).[/p]`;

const patches = (calls: { method: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === "PATCH").map((c) => c.body as Record<string, unknown>);
const puts = (calls: { method: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === "PUT").map((c) => c.body as Record<string, unknown>);

describe("reading text as Markdown", () => {
  it("wa_get shows text fields as Markdown by default, with a note", async () => {
    const { call } = await connect({ data: withContent(EDITOR) });
    const r = await call("wa_get", { type: "article", id: "article-edit-0001" });
    expect((untrustedJson(r.text) as { content: string }).content).toBe(
      `# Titre {#${U}}\n\nCouleur principale${NBSP}: Gueules\nCouleur secondaire${NBSP}: Sable\n\n⟦[p][/p]⟧\n\nVoir @[Orin](Article:article-edit-0002).`,
    );
    expect(r.text).toMatch(/Text fields are shown as Markdown/);
    expect(r.text).toMatch(/⟦…⟧ marks BBCode kept exactly as is/);
  });

  it('format: "bbcode" returns the raw text', async () => {
    const { call } = await connect({ data: withContent(EDITOR) });
    const r = await call("wa_get", { type: "article", id: "article-edit-0001", format: "bbcode" });
    expect((untrustedJson(r.text) as { content: string }).content).toBe(EDITOR);
    expect(r.text).not.toMatch(/shown as Markdown/);
  });
});

describe("writing Markdown", () => {
  it("creates text in the editor's form", async () => {
    const { call, fake } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "New",
      fields: { content: "Premier **gras**\nligne deux\n\n## Section\n\nDernier *ital*." },
    });
    expect(r.isError, r.text).toBe(false);
    expect(puts(fake.calls).at(-1)!.content).toBe(
      "[p]Premier [b]gras[/b][br]ligne deux[/p]\n[h2]Section[/h2]\n[p]Dernier [i]ital[/i].[/p]",
    );
  });

  it("raw_bbcode sends the text as is", async () => {
    const { call, fake } = await connect();
    await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "Raw",
      fields: { content: "**pas converti** [u]x[/u]" },
      raw_bbcode: true,
    });
    expect(puts(fake.calls).at(-1)!.content).toBe("**pas converti** [u]x[/u]");
  });

  it("editing one paragraph keeps every other byte (placeholders, empty paragraphs, heading id)", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    const read = await call("wa_get", { type: "article", id: "article-edit-0001" });
    const md = (untrustedJson(read.text) as { content: string }).content;
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: md.replace("Voir", "Voyez") },
      replace_fields: ["content"],
    });
    expect(r.isError, r.text).toBe(false);
    expect(patches(fake.calls).at(-1)!.content).toBe(EDITOR.replace("Voir", "Voyez"));
  });

  it("text sent back unchanged is not sent at all", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    const read = await call("wa_get", { type: "article", id: "article-edit-0001" });
    const md = (untrustedJson(read.text) as { content: string }).content;
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: md, nickname: "New" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(patches(fake.calls).at(-1)).toEqual({ nickname: "New" });
    expect(r.text).toMatch(/Unchanged, not sent: content/);
  });
});

describe("append mode", () => {
  it("adds a paragraph at the end of an editor-style field, keeping the rest byte for byte", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      append: { content: "Ajout **gras**." },
    });
    expect(r.isError, r.text).toBe(false);
    expect(patches(fake.calls).at(-1)!.content).toBe(`${EDITOR}\n[p]Ajout [b]gras[/b].[/p]`);
    expect(r.text).not.toMatch(/not kept intact/);
  });

  it("adds after a blank line in a plain field, and needs no replace confirmation", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      append: { content: "Ajout." },
    });
    expect(r.isError, r.text).toBe(false);
    expect(patches(fake.calls).at(-1)!.content).toBe("Original invented content.\n\nAjout.");
  });

  it("fills an empty field directly", async () => {
    const { call, fake } = await connect({ data: withContent("") });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", append: { content: "Premier." } });
    expect(patches(fake.calls).at(-1)!.content).toBe("[p]Premier.[/p]");
  });

  it("refuses to append to a non-text field or to the same field twice", async () => {
    const { call, fake } = await connect();
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const a = await call("wa_update_article", {
      id: "article-edit-0001",
      append: { nickname: "x" },
    });
    expect(a.text).toMatch(/not a text field/);
    const b = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "x" },
      append: { content: "y" },
      replace_fields: ["content"],
    });
    expect(b.text).toMatch(/both as a field and in append/);
    expect(patches(fake.calls)).toHaveLength(0);
  });
});

describe("replacing a whole text field", () => {
  it("is refused without replace_fields, and nothing is sent", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    for (const tool of ["wa_update_article", "wa_update"] as const) {
      const args =
        tool === "wa_update"
          ? { type: "article", id: "article-edit-0001", data: { content: "Tout nouveau." } }
          : { id: "article-edit-0001", fields: { content: "Tout nouveau." } };
      const r = await call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(
        /would replace the whole existing text of "content".*use append.*replace_fields: \["content"\]/,
      );
    }
    expect(patches(fake.calls)).toHaveLength(0);
  });

  it("with replace_fields, reports the structure that disappeared", async () => {
    const { call } = await connect({ data: withContent(EDITOR) });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Tout nouveau." },
      replace_fields: ["content"],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(
      /Replacing "content" removes: .*mention: 1 → 0.*\[h1\]: 1 → 0.*\[br\]: 1 → 0/,
    );
  });

  it("is not needed for an empty field", async () => {
    const { call } = await connect({ data: withContent("") });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const r = await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Premier." },
    });
    expect(r.isError, r.text).toBe(false);
  });
});

describe("mentions", () => {
  it("refuses a new mention of an element of another world", async () => {
    const { call, fake } = await connect();
    for (const target of ["article-open-0001", "article-blocked-0001"]) {
      const r = await call("wa_create_article", {
        world_id: EDIT_WORLD,
        title: "X",
        fields: { content: `Voir @[Autre](Article:${target}).` },
      });
      expect(r.text).toMatch(/mentions Article ".*", which is not in the same world/);
      expect(r.text).not.toMatch(/Hidden/);
    }
    expect(puts(fake.calls)).toHaveLength(0);
  });

  it("accepts Article and template-name types for elements of the same world", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "X",
      fields: {
        content: "@[Orin](Article:article-edit-0002) et @[Orin](organization:article-edit-0002)",
      },
    });
    expect(r.isError, r.text).toBe(false);
  });

  it("refuses a mention type it cannot check", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "X",
      fields: { content: "@[Carte](map:map-0001)" },
    });
    expect(r.text).toMatch(/cannot be checked against the world \(unknown type\)/);
  });

  it("does not re-check mentions already in the text, and reads each target once per session", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    const before = fake.calls.filter(
      (c) => c.method === "GET" && c.query.id === "article-edit-0002",
    ).length;
    await call("wa_update_article", { id: "article-edit-0001", append: { content: "Encore." } });
    await call("wa_update_article", {
      id: "article-edit-0001",
      append: { content: "Et @[Orin](Article:article-edit-0002)." },
    });
    await call("wa_update_article", {
      id: "article-edit-0001",
      append: { content: "Et encore @[Orin](person:article-edit-0002)." },
    });
    const after = fake.calls.filter(
      (c) => c.method === "GET" && c.query.id === "article-edit-0002",
    ).length;
    expect(after - before).toBe(1);
  });
});

describe("dry run and restore", () => {
  it("a dry run shows the BBCode that would be sent", async () => {
    const { call } = await connect();
    const r = await call("wa_create_article", {
      world_id: EDIT_WORLD,
      title: "D",
      fields: { content: "**x**" },
      dry_run: true,
    });
    expect(r.text).toContain('"content": "[p][b]x[/b][/p]"');
  });

  it("restore puts the raw text back without any conversion", async () => {
    const { call, fake } = await connect({ data: withContent(EDITOR) });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "Autre." },
      replace_fields: ["content"],
    });
    const list = await call("wa_restore", { type: "article", id: "article-edit-0001" });
    const backupId = /"backup_id": "([^"]+)"/.exec(list.text)![1]!;
    const r = await call("wa_restore", {
      type: "article",
      id: "article-edit-0001",
      backup_id: backupId,
    });
    expect(r.isError, r.text).toBe(false);
    expect(fake.data.articles.find((a) => a.id === "article-edit-0001")!.content).toBe(EDITOR);
  });
});

describe("layouts seen live", () => {
  it("a field ending with a newline stays in paragraph mode and keeps its newline on write", async () => {
    const { call, fake } = await connect({ data: withContent("[p]a[/p]\n[p][/p]\n[p]b[/p]\n") });
    const read = await call("wa_get", { type: "article", id: "article-edit-0001" });
    expect((untrustedJson(read.text) as { content: string }).content).toBe("a\n\n⟦[p][/p]⟧\n\nb");
    await call("wa_update_article", {
      id: "article-edit-0001",
      fields: { content: "c" },
      replace_fields: ["content"],
    });
    expect(patches(fake.calls).at(-1)!.content).toBe("[p]c[/p]\n");
  });

  it("append after a trailing newline adds one paragraph and keeps the newline at the end", async () => {
    const { call, fake } = await connect({ data: withContent("[p]a[/p]\n") });
    await call("wa_get", { type: "article", id: "article-edit-0001" });
    await call("wa_update_article", { id: "article-edit-0001", append: { content: "Nouveau." } });
    expect(patches(fake.calls).at(-1)!.content).toBe("[p]a[/p]\n[p]Nouveau.[/p]\n");
  });

  it("the history field of a template not probed yet is converted like any text field", async () => {
    const data = seedData();
    data.articles.push({
      id: "article-edit-0009",
      title: "Invented Species",
      templateType: "species",
      world: { id: EDIT_WORLD, title: "Testland Gamma", entityClass: "World" },
      history: "[p]Origines.[/p]\n[ul]\n- un\n-- deux\n[/ul]",
      updateDate: { date: "2026-07-09 10:00:00.000000" },
    });
    const { call, fake } = await connect({ data });
    const r = await call("wa_get", { type: "article", id: "article-edit-0009" });
    expect((untrustedJson(r.text) as { history: string }).history).toBe(
      "Origines.\n\n- un\n  - deux",
    );
    await call("wa_update_article", { id: "article-edit-0009", append: { history: "Suite." } });
    expect(patches(fake.calls).at(-1)!.history).toBe(
      "[p]Origines.[/p]\n[ul]\n- un\n-- deux\n[/ul]\n[p]Suite.[/p]",
    );
  });
});
