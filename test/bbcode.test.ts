import { describe, expect, it } from "vitest";
import {
  bbcodeToMarkdown,
  markdownToBbcode,
  mentionsIn,
  missingStructure,
  writeLayoutFor,
} from "../src/content/bbcode.js";

const U = "0a1b2c3d-1111-2222-3333-444455556666";
const NBSP = "\u00a0";
const NNBSP = "\u202f";

const roundTrip = (bb: string) => {
  const v = bbcodeToMarkdown(bb);
  return markdownToBbcode(v.markdown, v.layout);
};

/** Invented texts covering the forms seen live and the awkward cases. */
const FIXTURES: Record<string, string> = {
  "editor paragraphs with a line break": `[p]Couleur principale${NBSP}: Gueules (rouge)[br]Couleur secondaire${NBSP}: Sable (noir)[/p]\n[p]Second paragraphe.[/p]`,
  "empty paragraphs": "[p]Un.[/p]\n[p][/p]\n[p][/p]\n[p]Deux.[/p]",
  "only empty paragraphs": "[p][/p]\n[p][/p]",
  "French typography": `[p]Le «${NBSP}roi${NBSP}» d’Orvane — dit-on… a parlé${NNBSP}! Vraiment${NNBSP}? Oui${NNBSP}; enfin${NBSP}: 1914–1918.[/p]`,
  "heading, bold, italic, mention": `[h2]Histoire[/h2]\n[p]@[Elara Vane](Article:${U}) est [b]reine[/b] et [i]sage[/i].[/p]`,
  "mention right after a tag": `[p]@[Orin](person:${U})[/p]`,
  "mention in bold": `[p][b]@[Orin](Article:${U})[/b][/p]`,
  "unknown tags":
    "[p][section:lead]Intro [u]souligné[/u][/section] et [container:box]x[/container][/p]",
  "heading with an id": `[h1|${U}]Titre[/h1]\n[p]Texte.[/p]`,
  "plain field with sidebar lines":
    "Ligne 1\nLigne 2\n--Population::12--\n--Ruler::Invented--\n[b]gras[/b]",
  "mixed layout": "Texte libre\n[p]Paragraphe[/p]",
  "literal Markdown characters":
    "[p]5 * 3 = 15, a*b*c, \\ et # dièse, _souligné_, `code`, ~tilde~[/p]",
  "paragraph that looks like a heading": "[p]# pas un titre[/p]\n[p]## non plus[/p]",
  "paragraph that looks bold": "[p]**pas gras** et *pas italique*[/p]",
  "uppercase tags": "[P]x[/P]\n[p][B]y[/B][/p]",
  "crossing tags": "[p][b]a[i]b[/b]c[/i][/p]",
  "unclosed tags": "[p][b]a[/p]\n[p]b[/i][/p]",
  "trailing line break": "[p]a[br][/p]\n[p]b[/p]",
  "double line break": "[p]a[br][br]b[/p]",
  "br spellings": "[p]a[br/]b[br /]c[/p]",
  "placeholder characters in text": "[p]⟦déjà⟧ là \\⟦ ⟧[/p]",
  backslashes: "[p]C:\\chemin\\ et \\\\double et fin\\[/p]",
  CRLF: "a\r\nb\r\n[p]c[/p]",
  "blank line between paragraphs": "[p]a[/p]\n\n[p]b[/p]",
  "two paragraphs on one line": "[p]a[/p][p]b[/p]",
  "trailing newline": "[p]a[/p]\n",
  "spaces inside a paragraph": "[p]  x  [/p]",
  "bold italic nesting": "[p][b][i]x[/i][/b] [i][b]y[/b][/i][/p]",
  "adjacent emphasis": "[p][b]a[/b][i]b[/i][b]c[/b][/p]",
  "empty heading": "[h3][/h3]",
  "nul characters": "a\u00000\u0000b",
  "text in brackets": "[p][Elara] et [ autre ] et [/p]\n[p][Nom][/p]",
  "bare mention-like text": "[p]@[pas une mention] et @[x](pas:)[/p]",
  "only text": "Bonjour",
  "url and image": "[p][url:https://example.invalid]lien[/url] [img:123|left][/p]",
  "unknown heading parameter": "[h2|not an id]T[/h2]\n[p]x[/p]",
  dashes: "[p]Il vint — enfin — en 1914–1918 ; – réplique.[/p]",
  "list, two levels, trailing spaces":
    "[p]Avant[/p]\n[ul]\n- élément \n-- sous-élément : valeur\n- élément [b]gras[/b]\n[/ul]\n[p]Après[/p]",
  "list alone": "[ul]\n- a\n- b\n[/ul]",
  "empty list item": "[ul]\n- \n- b\n[/ul]",
  "list with an odd line": "[ul]\n- a\nsans tiret\n[/ul]",
  "unclosed list": "[ul]\n- a\n- b",
  "list sub-item next to a sidebar line":
    "[ul]\n-- nom : valeur\n-- Clé::Valeur--\n[/ul]\n--Clé::Valeur--\n-- nom : valeur",
  "several line breaks in a paragraph": "[p]un[br]deux[br]trois[br]quatre[/p]",
  "heading after a paragraph": "[p]a[/p]\n[h2]Titre[/h2]\n[p]b[/p]",
  "heading right after [/p] on the same line": "[p]a[/p][h2]Titre[/h2]",
  "empty paragraphs interleaved": "[p]a[/p]\n[p][/p]\n[p]b[/p]\n[p][/p]\n[p][/p]\n[p]c[/p]",
  "trailing newline after paragraphs": "[p]a[/p]\n[p][/p]\n[p]b[/p]\n",
  "leading and trailing blank lines": "\n\n[p]a[/p]\n\n",
  "paragraph starting with a dash":
    "[p]- dialogue[/p]\n[p]Intro[br]- point[/p]\n[p]-- pas une liste[/p]",
  "heading text ending like an id": "[h2]T {#abc}[/h2]",
  "sidebar lines before, between and after paragraphs":
    "--Clé::Valeur--\n[p]a[/p]\n--Autre::Valeur--\n[p]b[/p]\n--Fin::x--\n",
  "line breaks at the start, the end, and doubled": "[p][br]a[br][br]b[br][/p]\n[p][br][/p]",
  "literal backslash lines": "[p]\\[br]\\\\[br]a\\[/p]",
  "raw newline inside a paragraph": "[p]a\nb[/p]",
  "sidebar-like line with a space after --": "[p]a[/p]\n-- Clé::Valeur--",
  "sample article made with the editor buttons":
    `[h1|${U}]T1[/h1]\n[h2|${U}]T2[/h2]\n[h3|${U}]T3[/h3]\n[h4|${U}]T4[/h4]\n[h5|${U}]T5[/h5]\n[h|${U}]Th[/h]\n[p][u]souligné[/u] [s]barré[/s][/p]\n[ol]\n- un\n-- deux\n--- trois\n- \n[/ol]\n[] case un[br]\n[] case deux[br]\n[p]Voir [category:${U}]cat[/category] et [timeline:${U}]chrono[/timeline].[/p]\n[p]https://example.invalid/page[/p]\n--Clé::Valeur-- \n[table][tr][th]A[/th][th]B[/th][/tr][tr][td]1[/td][td]2[/td][/tr][/table]\n[center][p]centré [color:#00ff00]vert[/color][/p][/center]\n[right][p]droite[/p][/right]\n[quote]Une citation.[/quote]\n[aloud]À voix haute[/aloud]\n[spoiler]Caché[/spoiler]\n[hr]\n[p] [/p]\n[p][br][br][/p]\n[secret:${U}]\n[img:123|none]\n` +
    Array<string>(234).fill("[p][/p]").join("\n") +
    "\n",
  "ul with three levels and an empty item": "[ul]\n- a\n-- b\n--- c\n- \n[/ul]",
  "check list lines": "[p]Liste[/p]\n[] un[br]\n[] deux[br]\n[p]Fin[/p]",
  "sidebar line with a trailing blank between paragraphs": "[p]a[/p]\n--Clé::Valeur-- \n[p]b[/p]",
  "sidebar lines between paragraphs":
    "[p]Intro[/p]\n--Population::12--\n--Ruler::Invented--\n[p]Fin[/p]",
  "sidebar line inside a paragraph": "[p]--Population::12--[br]--Ruler::Invented--[/p]",
  "paragraph that looks like a sidebar line": "[p]--x::y--[/p]",
};

describe("BBCode → Markdown → BBCode is byte-identical", () => {
  it("returns empty for empty", () => {
    expect(bbcodeToMarkdown("")).toMatchObject({ markdown: "", mode: "paragraph" });
    expect(markdownToBbcode("", "paragraph")).toBe("");
  });

  it.each(Object.entries(FIXTURES))("%s", (_name, bb) => {
    expect(roundTrip(bb)).toBe(bb);
  });

  it("holds for 5000 random texts made of tricky pieces", () => {
    const pieces = [
      "[p]",
      "[/p]",
      "[br]",
      "[b]",
      "[/b]",
      "[i]",
      "[/i]",
      "[h2]",
      "[/h2]",
      `[h1|${U}]`,
      "[/h1]",
      "\n",
      "\n\n",
      "*",
      "**",
      "\\",
      "#",
      "# ",
      "⟦",
      "⟧",
      `@[A](Article:${U})`,
      "@[",
      "](",
      ")",
      "texte",
      "é",
      NBSP,
      NNBSP,
      "’",
      " ",
      "[u]",
      "[/u]",
      "[",
      "]",
      "[section:x]",
      "--K::V--",
      "\r\n",
      "[ul]",
      "[/ul]",
      "\n- ",
      "\n-- ",
      "- ",
      "  - ",
      "—",
      "–",
      `[h2|${U}]`,
      " {#a}",
      "[p][/p]",
      "-- nom : x",
      "\\\n",
      "[br][br]",
      "--A::b--\n",
      "[s]",
      "[/s]",
      "~~",
      "~",
      "[hr]",
      "[quote]",
      "[/quote]",
      "> ",
      "[ol]",
      "[/ol]",
      "\n--- ",
      "1. ",
      "   2. ",
      "[] ",
      `[category:${U}]`,
      "[/category]",
      "×",
      "[p][/p]\n[p][/p]",
      "[table][tr][td]x[/td][/tr][/table]",
      "[center]",
      `[h|${U}]`,
      "[p] [/p]",
      ".",
    ];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 5000; n++) {
      let bb = "";
      const len = Math.floor(rand() * 25);
      for (let k = 0; k < len; k++) bb += pieces[Math.floor(rand() * pieces.length)];
      expect(roundTrip(bb), JSON.stringify(bb)).toBe(bb);
    }
  });
});

describe("readable Markdown for the editor's forms", () => {
  it("paragraphs become blank-line paragraphs and [br] a line break", () => {
    const v = bbcodeToMarkdown(FIXTURES["editor paragraphs with a line break"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.markdown).toBe(
      `Couleur principale${NBSP}: Gueules (rouge)\nCouleur secondaire${NBSP}: Sable (noir)\n\nSecond paragraphe.`,
    );
    expect(v.hasPlaceholders).toBe(false);
  });

  it("empty paragraphs show as explicit placeholders", () => {
    expect(bbcodeToMarkdown(FIXTURES["empty paragraphs"]!).markdown).toBe(
      "Un.\n\n⟦[p][/p]×2⟧\n\nDeux.",
    );
  });

  it("headings, emphasis and mentions convert; the mention keeps its exact form", () => {
    expect(bbcodeToMarkdown(FIXTURES["heading, bold, italic, mention"]!).markdown).toBe(
      `## Histoire\n\n@[Elara Vane](Article:${U}) est **reine** et *sage*.`,
    );
  });

  it("French typography passes untouched and nothing is escaped needlessly", () => {
    const bb = FIXTURES["French typography"]!;
    expect(bbcodeToMarkdown(bb).markdown).toBe(bb.slice(3, -4));
    expect(bbcodeToMarkdown("[p]5 * 3 = 15, _x_, #1[/p]").markdown).toBe("5 * 3 = 15, _x_, #1");
  });

  it("escapes only where Markdown would interpret", () => {
    expect(bbcodeToMarkdown("[p]# pas un titre[/p]").markdown).toBe("\\# pas un titre");
    expect(bbcodeToMarkdown("[p]a *b* c[/p]").markdown).toBe("a \\*b\\* c");
  });

  it("keeps unknown tags and unknown heading parameters as placeholders", () => {
    expect(bbcodeToMarkdown(FIXTURES["unknown tags"]!).markdown).toBe(
      "⟦[section:lead]⟧Intro ⟦[u]⟧souligné⟦[/u]⟧⟦[/section]⟧ et ⟦[container:box]⟧x⟦[/container]⟧",
    );
    expect(bbcodeToMarkdown(FIXTURES["unknown heading parameter"]!).markdown).toBe(
      "⟦[h2|not an id]T[/h2]⟧\n\nx",
    );
  });

  it("headings with an id keep it exactly", () => {
    expect(bbcodeToMarkdown(FIXTURES["heading with an id"]!).markdown).toBe(
      `# Titre {#${U}}\n\nTexte.`,
    );
    expect(markdownToBbcode(`## Titre {#${U}}`, "paragraph")).toBe(`[h2|${U}]Titre[/h2]`);
    expect(markdownToBbcode("## Titre", "paragraph")).toBe("[h2]Titre[/h2]");
  });

  it("the editor's lists become two-level Markdown lists, trailing spaces kept", () => {
    const v = bbcodeToMarkdown(FIXTURES["list, two levels, trailing spaces"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.markdown).toBe(
      "Avant\n\n- élément \n  - sous-élément : valeur\n- élément **gras**\n\nAprès",
    );
    expect(markdownToBbcode("- un\n  - deux\n- trois", "paragraph")).toBe(
      "[ul]\n- un\n-- deux\n- trois\n[/ul]",
    );
  });

  it("a list sub-item is never taken for a sidebar line, and the reverse", () => {
    const bb = FIXTURES["list sub-item next to a sidebar line"]!;
    expect(roundTrip(bb)).toBe(bb);
    const v = bbcodeToMarkdown("[ul]\n-- nom : valeur\n-- Clé::Valeur--\n[/ul]\n--Clé::Valeur--");
    expect(v.markdown).toBe("  - nom : valeur\n  - Clé::Valeur--\n\n--Clé::Valeur--");
    expect(markdownToBbcode("--Clé::Valeur--", "paragraph")).toBe("--Clé::Valeur--");
    expect(markdownToBbcode("-- nom : valeur", "paragraph")).toBe("[p]-- nom : valeur[/p]");
  });

  it("interleaved empty paragraphs stay on their own lines without leaving paragraph mode", () => {
    const v = bbcodeToMarkdown(FIXTURES["empty paragraphs interleaved"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.markdown).toBe("a\n\n⟦[p][/p]⟧\n\nb\n\n⟦[p][/p]×2⟧\n\nc");
  });

  it("a trailing newline keeps the field in paragraph mode and is put back on write", () => {
    const v = bbcodeToMarkdown(FIXTURES["trailing newline after paragraphs"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.layout.trail).toBe("\n");
    expect(v.markdown).toBe("a\n\n⟦[p][/p]⟧\n\nb");
  });

  it("escapes a dash only where it would start a list", () => {
    expect(bbcodeToMarkdown(FIXTURES["paragraph starting with a dash"]!).markdown).toBe(
      "\\- dialogue\n\nIntro\n- point\n\n-- pas une liste",
    );
  });

  it("several line breaks and dashes read naturally", () => {
    expect(bbcodeToMarkdown(FIXTURES["several line breaks in a paragraph"]!).markdown).toBe(
      "un\ndeux\ntrois\nquatre",
    );
    expect(bbcodeToMarkdown(FIXTURES["dashes"]!).markdown).toBe(
      "Il vint — enfin — en 1914–1918 ; – réplique.",
    );
  });

  it("a sidebar line alone on its line is a block before, between or after paragraphs", () => {
    const v = bbcodeToMarkdown(FIXTURES["sidebar lines before, between and after paragraphs"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.hasPlaceholders).toBe(false);
    expect(v.markdown).toBe("--Clé::Valeur--\n\na\n\n--Autre::Valeur--\n\nb\n\n--Fin::x--");
  });

  it("line breaks at a paragraph's start or end, or doubled, convert with a '\\' line", () => {
    const v = bbcodeToMarkdown(FIXTURES["line breaks at the start, the end, and doubled"]!);
    expect(v.mode).toBe("paragraph");
    expect(v.hasPlaceholders).toBe(false);
    expect(v.markdown).toBe("\\\na\n\\\nb\n\\\n\n\\\n\\");
    expect(markdownToBbcode("a\n\\\nb", "paragraph")).toBe("[p]a[br][br]b[/p]");
  });

  it("names the rule behind each placeholder, without content", () => {
    expect(bbcodeToMarkdown("[p]a[/p]\n[p][/p]").placeholderShapes).toEqual(["empty paragraph"]);
    expect(bbcodeToMarkdown("[p]a[/p]\n[p][/p]\n[p][/p]").placeholderShapes).toEqual([
      "empty paragraphs",
    ]);
    expect(bbcodeToMarkdown("[p]x[/p]\n[p]a[/p][p]b[/p]").placeholderShapes).toEqual([
      "several blocks on one line",
    ]);
    expect(bbcodeToMarkdown("[p]x [u]y[/u][/p]").placeholderShapes).toEqual([
      "inline tag without a Markdown form",
      "inline tag without a Markdown form",
    ]);
    expect(bbcodeToMarkdown("[p]a[/p]\n-- Clé::Valeur-- ").placeholderShapes).toEqual([
      "list item outside a list",
    ]);
    expect(bbcodeToMarkdown("[p]a[/p]\ntexte").placeholderShapes).toEqual([
      "text line outside blocks",
    ]);
    expect(bbcodeToMarkdown("[p]a[/p]\n[] un[br]\n[] deux[br]").placeholderShapes).toEqual([
      "check list",
    ]);
    expect(
      bbcodeToMarkdown("[p]a[/p]\n[table][tr][td]x[/td][/tr][/table]").placeholderShapes,
    ).toEqual(["line wrapped in another tag"]);
    expect(bbcodeToMarkdown(`[h|${U}]T[/h]\n[p]a[/p]`).placeholderShapes).toEqual([
      "heading with an unknown parameter",
    ]);
    expect(bbcodeToMarkdown("[p] [/p]\n[p]a[/p]").placeholderShapes).toEqual(["blank paragraph"]);
  });

  it("only a field with no block at all is in plain mode", () => {
    expect(bbcodeToMarkdown("Ligne\nLigne").fallbackReason).toBe("no-block-tags");
    expect(bbcodeToMarkdown("[p]a[/p]\ntexte libre").mode).toBe("paragraph");
    expect(bbcodeToMarkdown("[p]a[/p]\n\n[p]b[/p]").mode).toBe("paragraph");
    expect(bbcodeToMarkdown("[ul]\n- a").mode).toBe("plain"); // no block reads as text
    expect(bbcodeToMarkdown("[ul]\n- a").fallbackReason).toBe("no-readable-block");
    expect(bbcodeToMarkdown("[p]a[/p]").fallbackReason).toBeUndefined();
  });

  it("a block that does not convert is one placeholder on its own line; the rest stays readable", () => {
    const v = bbcodeToMarkdown("[p]Avant[/p]\n- hors liste\n-- encore\n[p]Après[/p]");
    expect(v.mode).toBe("paragraph");
    expect(v.markdown).toBe("Avant\n\n⟦- hors liste\n-- encore⟧\n\nAprès");
    const t = bbcodeToMarkdown(
      "[p]a[/p]\n[center][p]centré [color:#ff0000]rouge[/color][/p][/center]\n[p]b[/p]",
    );
    expect(t.markdown).toBe(
      "a\n\n⟦[center][p]centré [color:#ff0000]rouge[/color][/p][/center]⟧\n\nb",
    );
  });

  it("a long run of empty paragraphs is one compact placeholder, restored exactly", () => {
    const bb = "[p]Fin.[/p]\n" + Array<string>(234).fill("[p][/p]").join("\n") + "\n";
    const v = bbcodeToMarkdown(bb);
    expect(v.markdown).toBe("Fin.\n\n⟦[p][/p]×234⟧");
    expect(markdownToBbcode(v.markdown, v.layout)).toBe(bb);
  });

  it("a × inside an ordinary placeholder is escaped, so it is never read as a run", () => {
    const bb = "[p]a[/p]\n[p][/p]×3";
    expect(roundTrip(bb)).toBe(bb);
    expect(bbcodeToMarkdown(bb).markdown).toContain("\\×");
  });

  it("converts [s], [hr], one-line [quote] and headings h1–h5 with an id", () => {
    const bb = `[h1|${U}]Un[/h1]\n[h5|${U}]Cinq[/h5]\n[p]a [s]barré[/s][/p]\n[hr]\n[quote]Citation [b]forte[/b][/quote]`;
    const v = bbcodeToMarkdown(bb);
    expect(v.hasPlaceholders).toBe(false);
    expect(v.markdown).toBe(
      `# Un {#${U}}\n\n##### Cinq {#${U}}\n\na ~~barré~~\n\n---\n\n> Citation **forte**`,
    );
    expect(markdownToBbcode(v.markdown, v.layout)).toBe(bb);
  });

  it("converts [ul] and [ol] lists with three levels; [ol] reads as a numbered list", () => {
    const ul = "[ul]\n- un\n-- deux\n--- trois\n- \n[/ul]";
    expect(bbcodeToMarkdown(ul).markdown).toBe("- un\n  - deux\n    - trois\n- ");
    const ol = "[ol]\n- un\n-- un.un\n-- un.deux\n--- profond\n- deux\n-- deux.un\n[/ol]";
    expect(bbcodeToMarkdown(ol).markdown).toBe(
      "1. un\n   1. un.un\n   2. un.deux\n      1. profond\n2. deux\n   1. deux.un",
    );
    expect(roundTrip(ol)).toBe(ol);
    expect(markdownToBbcode("1. a\n   7. b\n3. c", "paragraph")).toBe(
      "[ol]\n- a\n-- b\n- c\n[/ol]",
    );
  });

  it("category and timeline links keep their tags as placeholders around readable text", () => {
    const bb = `[p]Voir [category:${U}]la catégorie[/category] et [timeline:${U}]la chronologie[/timeline].[/p]`;
    expect(bbcodeToMarkdown(bb).markdown).toBe(
      `Voir ⟦[category:${U}]⟧la catégorie⟦[/category]⟧ et ⟦[timeline:${U}]⟧la chronologie⟦[/timeline]⟧.`,
    );
    expect(mentionsIn(bb)).toEqual([
      { type: "category", id: U },
      { type: "timeline", id: U },
    ]);
  });

  it("a paragraph that would read as a list, quote, rule or numbered item is escaped", () => {
    const bb = "[p]1. pas une liste[/p]\n[p]> pas une citation[/p]\n[p]---[/p]";
    expect(bbcodeToMarkdown(bb).markdown).toBe(
      "1\\. pas une liste\n\n\\> pas une citation\n\n\\---",
    );
  });

  it("plain fields keep their lines and sidebar key-value lines untouched", () => {
    const v = bbcodeToMarkdown(FIXTURES["plain field with sidebar lines"]!);
    expect(v.mode).toBe("plain");
    expect(v.markdown).toBe("Ligne 1\nLigne 2\n--Population::12--\n--Ruler::Invented--\n**gras**");
  });
});

describe("new Markdown is written in the editor's form", () => {
  it("paragraphs separated by \\n, line breaks as [br], headings, emphasis, mentions", () => {
    const md = `Para un\nligne deux\n\nPara deux\n\n\n\n## Titre\n\n**gras** et *ital* @[X](Article:${U})`;
    expect(markdownToBbcode(md, "paragraph")).toBe(
      `[p]Para un[br]ligne deux[/p]\n[p]Para deux[/p]\n[h2]Titre[/h2]\n[p][b]gras[/b] et [i]ital[/i] @[X](Article:${U})[/p]`,
    );
  });

  it("sidebar key-value lines pass through untouched, even in a new field", () => {
    expect(markdownToBbcode("--Population::12--", "paragraph")).toBe("--Population::12--");
    expect(markdownToBbcode("--A::1--\n--B::2--\n\nTexte", "paragraph")).toBe(
      "--A::1--\n--B::2--\n[p]Texte[/p]",
    );
    expect(bbcodeToMarkdown("[p]Intro[/p]\n--Population::12--").markdown).toBe(
      "Intro\n\n--Population::12--",
    );
  });

  it("a lone * stays literal", () => {
    expect(markdownToBbcode("5 * 3", "paragraph")).toBe("[p]5 * 3[/p]");
  });

  it("placeholders are restored exactly, even with blank lines inside", () => {
    expect(markdownToBbcode("⟦[section:a]\n\nx⟧", "paragraph")).toBe("[section:a]\n\nx");
  });

  it("chooses the write layout from the field's current text", () => {
    expect(writeLayoutFor(undefined)).toEqual({ mode: "paragraph", lead: "", trail: "" });
    expect(writeLayoutFor("")).toEqual({ mode: "paragraph", lead: "", trail: "" });
    expect(writeLayoutFor("[p]a[/p]\n")).toEqual({ mode: "paragraph", lead: "", trail: "\n" });
    expect(writeLayoutFor("Ligne\n--K::V--").mode).toBe("plain");
  });
});

describe("helpers", () => {
  it("lists mentions with their exact type", () => {
    expect(mentionsIn(`@[A](Article:${U}) et @[B](person:x-1)`)).toEqual([
      { type: "Article", id: U },
      { type: "person", id: "x-1" },
    ]);
  });

  it("reports structure that disappeared", () => {
    expect(
      missingStructure(`[p][section:a]x[/section] @[A](Article:${U})[/p]\n--K::V--`, "[p]x[/p]"),
    ).toEqual(["mention: 1 → 0", "[section]: 1 → 0", "--key::value-- line: 1 → 0"]);
  });
});
