import { describe, expect, it } from "vitest";
import {
  bbcodeToMarkdown,
  markdownToBbcode,
  mentionsIn,
  missingStructure,
  writeModeFor,
} from "../src/content/bbcode.js";

const U = "0a1b2c3d-1111-2222-3333-444455556666";
const NBSP = "\u00a0";
const NNBSP = "\u202f";

const roundTrip = (bb: string) => {
  const v = bbcodeToMarkdown(bb);
  return markdownToBbcode(v.markdown, v.mode);
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

  it("keeps unknown tags and heading ids as placeholders", () => {
    expect(bbcodeToMarkdown(FIXTURES["unknown tags"]!).markdown).toBe(
      "⟦[section:lead]⟧Intro ⟦[u]⟧souligné⟦[/u]⟧⟦[/section]⟧ et ⟦[container:box]⟧x⟦[/container]⟧",
    );
    expect(bbcodeToMarkdown(FIXTURES["heading with an id"]!).markdown).toBe(
      `⟦[h1|${U}]Titre[/h1]⟧\n\nTexte.`,
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

  it("chooses the write mode from the field's current text", () => {
    expect(writeModeFor(undefined)).toBe("paragraph");
    expect(writeModeFor("")).toBe("paragraph");
    expect(writeModeFor("[p]a[/p]")).toBe("paragraph");
    expect(writeModeFor("Ligne\n--K::V--")).toBe("plain");
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
