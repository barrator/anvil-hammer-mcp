import { describe, expect, it } from "vitest";
import {
  emptyInventory,
  scanBbcodeField,
  scanUnflaggedField,
  shareable,
} from "../live/bbcode-inventory.js";

const UUID = "0a1b2c3d-1111-2222-3333-444455556666";

describe("BBCode inventory (probe analysis)", () => {
  it("counts paragraphs, line breaks, headings with ids, mentions, links and sidebar lines", () => {
    const inv = emptyInventory();
    scanBbcodeField(
      inv,
      "article",
      "content",
      `[h1|${UUID}]Invented Heading[/h1][p]Couleur principale: Gueules[br]Couleur secondaire: Sable[/p]\n[p]See @[Invented Place](article:${UUID}) and [url:https://example.invalid]a link[/url].[/p][p][/p]`,
    );
    scanBbcodeField(inv, "article", "sidebarcontent", "--Population::12--\n--Ruler::Invented--");
    expect(inv.tags.p).toMatchObject({ open: 3, close: 3 });
    expect(inv.paragraphs.separators).toEqual({ "\\n": 1, none: 1 });
    expect(inv.paragraphs.emptyParagraphs).toBe(1);
    expect(inv.paragraphs.fieldsMixed).toBe(1); // the heading sits outside paragraphs
    expect(inv.lineBreaks).toMatchObject({ forms: { "[br]": 1 }, insideParagraph: 1 });
    expect(inv.headings.forms).toEqual({ "h1:uuid": 1 });
    expect(inv.headings.context).toEqual({ "field-start": 1 });
    expect(inv.mentions).toMatchObject({
      withTarget: 1,
      targetTypes: { article: 1 },
      targetIdShape: { uuid: 1 },
    });
    expect(inv.links.forms).toEqual({ "url:": 1 });
    expect(inv.links.targetShape).toEqual({ https: 1 });
    expect(inv.sidebarLines).toBe(2);
    expect(inv.paragraphs.fieldsWithoutParagraphs).toBe(1);
  });

  it("counts French typography and Markdown-significant characters", () => {
    const inv = emptyInventory();
    scanBbcodeField(
      inv,
      "article",
      "content",
      "Il dit : « oui » – l’été — fin…\n# not a heading\n* star_under",
    );
    expect(inv.typography).toMatchObject({
      "U+00A0 no-break space": 2,
      "U+202F narrow no-break space": 1,
      "’ apostrophe": 1,
      "« »": 2,
      "– en dash": 1,
      "— em dash": 1,
    });
    expect(inv.markdownChars).toMatchObject({ "*": 1, _: 1, "# at line start": 1 });
  });

  it("never puts text or unknown tag names in the shareable part", () => {
    const inv = emptyInventory();
    scanBbcodeField(
      inv,
      "article",
      "content",
      "[p]Secret plot about [Elara] and [Elara]x[/Elara][/p]",
    );
    scanUnflaggedField(inv, "excerpt", "Short [b]bold[/b] excerpt");
    const shared = JSON.stringify(shareable(inv));
    expect(shared).not.toMatch(/Elara|Secret plot|bold|excerpt text/);
    expect(shareable(inv).unknownTags).toEqual({ distinctNames: 1, occurrences: 3 });
    expect(inv.localOnly.unknownTagNames).toEqual({ Elara: 3 });
    expect(inv.unflaggedFieldsWithTags).toEqual({ excerpt: 1 });
  });

  it("detects br spellings, line breaks followed by a newline, and uppercase tags", () => {
    const inv = emptyInventory();
    scanBbcodeField(inv, "article", "content", "a[br]\nb[br/]c[BR]d[br /]e");
    expect(inv.lineBreaks.forms).toEqual({ "[br]": 2, "[br/]": 1, "[br /]": 1 });
    expect(inv.lineBreaks.followedByNewline).toBe(1);
    expect(inv.tags.br!.notLowercase).toBe(1);
  });
});
