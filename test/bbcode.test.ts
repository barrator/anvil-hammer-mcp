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
      "Un.\n\n⟦[p][/p]⟧\n\n⟦[p][/p]⟧\n\nDeux.",
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
    expect(v.markdown).toBe("a\n\n⟦[p][/p]⟧\n\nb\n\n⟦[p][/p]⟧\n\n⟦[p][/p]⟧\n\nc");
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

  it("names the rule behind each placeholder and each plain-mode fallback, without content", () => {
    expect(bbcodeToMarkdown("[p]a[/p]\n[p][/p]").placeholderShapes).toEqual(["empty paragraph"]);
    expect(bbcodeToMarkdown("[p]a[/p][p]b[/p]").placeholderShapes).toEqual([
      "several blocks on one line",
    ]);
    expect(bbcodeToMarkdown("[p]x [u]y[/u][/p]").placeholderShapes).toEqual([
      "inline tag without a Markdown form",
      "inline tag without a Markdown form",
    ]);
    expect(bbcodeToMarkdown("[p]a[/p]\n-- Clé::Valeur--")).toMatchObject({
      fallbackReason: "line-outside-blocks",
      fallbackDetail: "sidebar-like line: space after --",
    });
    expect(bbcodeToMarkdown("[p]a\nb[/p]").fallbackDetail).toBe(
      "paragraph continues on the next line (raw newline inside [p])",
    );
    expect(bbcodeToMarkdown("[p]a[/p]\ntexte").fallbackDetail).toBe("text line without tags");
    expect(bbcodeToMarkdown("[p]a[/p]\n- item").fallbackDetail).toBe("list item outside [ul]");
    expect(
      bbcodeToMarkdown("[p]a[/p]\ntexte").placeholderShapes.every(
        (x) => x === "tag in a plain-mode field",
      ),
    ).toBe(true);
  });

  it("reports why a field stays in plain mode", () => {
    expect(bbcodeToMarkdown("Ligne\nLigne").fallbackReason).toBe("no-block-tags");
    expect(bbcodeToMarkdown("[p]a[/p]\ntexte libre").fallbackReason).toBe("line-outside-blocks");
    expect(bbcodeToMarkdown("[p]a[/p]\n\n[p]b[/p]").fallbackReason).toBe("empty-line");
    expect(bbcodeToMarkdown("[ul]\n- a").fallbackReason).toBe("unclosed-list");
    expect(bbcodeToMarkdown("[p]a[/p]").fallbackReason).toBeUndefined();
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
