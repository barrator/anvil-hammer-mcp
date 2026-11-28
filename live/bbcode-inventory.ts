/**
 * BBCode inventory for the stage C probe: counts the forms World Anvil really
 * stores (paragraphs, line breaks, headings with ids, mentions, links, sidebar
 * lines, characters that matter for Markdown escaping, French typography).
 *
 * The summary holds counts, known WA tag names and field names only. Names of
 * unknown tags could be the owner's own words written in brackets (e.g. a
 * character name), so they are kept apart in `localOnly`, never in the summary.
 */

/** BBCode tags World Anvil is known to use (reported by name). */
export const KNOWN_TAGS = new Set([
  "b",
  "i",
  "u",
  "s",
  "strike",
  "sup",
  "sub",
  "small",
  "large",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "url",
  "img",
  "quote",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "code",
  "pre",
  "section",
  "container",
  "aloud",
  "spoiler",
  "redacted",
  "secret",
  "subscribergroup",
  "center",
  "left",
  "right",
  "justify",
  "indent",
  "color",
  "size",
  "font",
  "toc",
  "youtube",
  "spotify",
  "soundcloud",
  "map",
  "timeline",
  "block",
  "statblock",
  "articleblock",
  "article",
  "embed",
  "columns",
  "col",
  "row",
  "tooltip",
  "ooc",
  "inline",
]);

/** A tag token; group 4 is a self-closing slash ("[br/]", "[br /]"). */
const TAG = /\[(\/?)([A-Za-z][A-Za-z0-9_-]{0,30})([:=|][^\]\n]{0,300})?(\s*\/)?\]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENTION = /@\[([^\]\n]{1,300})\](\(([^)\n]{0,300})\))?/g;
const SIDEBAR = /^--[^\n]*?::[^\n]*?--$/gm;

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};

export interface TagStats {
  open: number;
  close: number;
  /** Parameter forms on the opening tag: none, ":", "=", "|uuid", "|other". */
  params: Counter;
  /** Occurrences not written in lowercase. */
  notLowercase: number;
}

export interface Inventory {
  fieldsScanned: number;
  fieldsEmpty: number;
  fieldsWithTags: number;
  /** type → bbcode fields scanned */
  byType: Counter;
  /** field name → fields scanned with that name */
  byField: Counter;
  tags: Record<string, TagStats>;
  paragraphs: {
    /** Whitespace between [/p] and the next [p]: "none", "\\n", "\\n\\n", "other". */
    separators: Counter;
    fieldsAllInParagraphs: number;
    fieldsMixed: number;
    fieldsWithoutParagraphs: number;
    emptyParagraphs: number;
    /** Block tags found inside a [p]…[/p]. */
    blocksInside: Counter;
    nested: number;
    unbalancedFields: number;
  };
  lineBreaks: {
    /** Exact spelling: "[br]", "[br/]", "[br /]", other. */
    forms: Counter;
    followedByNewline: number;
    insideParagraph: number;
    outsideParagraph: number;
  };
  newlines: { lf: number; crlf: number; fieldsWithRawNewlines: number };
  headings: {
    /** "h1:plain", "h1:uuid", "h1:other-param" … */
    forms: Counter;
    /** What precedes a heading: "field-start", "after-[/p]", "after-newline", "inside-[p]", "other". */
    context: Counter;
  };
  mentions: {
    withTarget: number;
    bare: number;
    /** Text before ":" in the target, exact case (e.g. "Article", "person"). */
    targetTypes: Counter;
    targetIdShape: Counter;
    otherTargetForms: number;
  };
  links: { forms: Counter; targetShape: Counter };
  sidebarLines: number;
  /** Markdown-significant characters in plain text (tags and mentions removed). */
  markdownChars: Counter;
  typography: Counter;
  placeholderChars: number;
  lists: { itemSeparators: Counter };
  /** "template.field" (or "type.field") of string fields not flagged BBCode that contain a known tag. */
  unflaggedFieldsWithTags: Counter;
  /** Never paste: may contain the owner's words. */
  localOnly: { unknownTagNames: Counter };
}

export function emptyInventory(): Inventory {
  return {
    fieldsScanned: 0,
    fieldsEmpty: 0,
    fieldsWithTags: 0,
    byType: {},
    byField: {},
    tags: {},
    paragraphs: {
      separators: {},
      fieldsAllInParagraphs: 0,
      fieldsMixed: 0,
      fieldsWithoutParagraphs: 0,
      emptyParagraphs: 0,
      blocksInside: {},
      nested: 0,
      unbalancedFields: 0,
    },
    lineBreaks: { forms: {}, followedByNewline: 0, insideParagraph: 0, outsideParagraph: 0 },
    newlines: { lf: 0, crlf: 0, fieldsWithRawNewlines: 0 },
    headings: { forms: {}, context: {} },
    mentions: { withTarget: 0, bare: 0, targetTypes: {}, targetIdShape: {}, otherTargetForms: 0 },
    links: { forms: {}, targetShape: {} },
    sidebarLines: 0,
    markdownChars: {},
    typography: {},
    placeholderChars: 0,
    lists: { itemSeparators: {} },
    unflaggedFieldsWithTags: {},
    localOnly: { unknownTagNames: {} },
  };
}

const BLOCKS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "quote",
  "table",
  "hr",
  "section",
  "container",
  "code",
  "pre",
]);

function paramForm(p: string | undefined): string {
  if (!p) return "none";
  if (p[0] === "|") return UUID.test(p.slice(1)) ? "|uuid" : "|other";
  return p[0]!;
}

function wsKind(ws: string): string {
  if (ws === "") return "none";
  if (ws === "\n") return "\\n";
  if (ws === "\n\n") return "\\n\\n";
  return "other";
}

/** Record one string field that the registry marks as BBCode. */
export function scanBbcodeField(inv: Inventory, type: string, field: string, text: string): void {
  inv.fieldsScanned++;
  inc(inv.byType, type);
  inc(inv.byField, field);
  if (!text.trim()) {
    inv.fieldsEmpty++;
    return;
  }

  // Newlines
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  inv.newlines.crlf += crlf;
  inv.newlines.lf += lf;
  if (crlf + lf > 0) inv.newlines.fieldsWithRawNewlines++;

  // Tags, with paragraph depth tracking
  let pDepth = 0;
  let sawTag = false;
  let unbalanced = false;
  let sawParagraph = false;
  // Mentions are atomic: their [Display name] must not be read as a tag.
  const withoutMentions = text.replace(MENTION, (m) => " ".repeat(m.length));
  for (const m of withoutMentions.matchAll(TAG)) {
    const closing = m[1] === "/";
    const rawName = m[2]!;
    const name = rawName.toLowerCase();
    const params = m[3];
    const at = m.index ?? 0;
    if (!KNOWN_TAGS.has(name)) {
      inc(inv.localOnly.unknownTagNames, rawName);
      continue;
    }
    sawTag = true;
    const t = (inv.tags[name] ??= { open: 0, close: 0, params: {}, notLowercase: 0 });
    if (rawName !== name) t.notLowercase++;
    if (closing) t.close++;
    else {
      t.open++;
      inc(t.params, paramForm(params));
    }

    if (name === "p") {
      sawParagraph = true;
      if (closing) {
        pDepth--;
        if (pDepth < 0) {
          unbalanced = true;
          pDepth = 0;
        }
      } else {
        if (pDepth > 0) inv.paragraphs.nested++;
        pDepth++;
      }
    } else if (!closing && pDepth > 0 && BLOCKS.has(name)) {
      inc(inv.paragraphs.blocksInside, name);
    }

    if (name === "br" && !closing) {
      const spelled = m[0];
      inc(
        inv.lineBreaks.forms,
        ["[br]", "[br/]", "[br /]"].includes(spelled.toLowerCase())
          ? spelled.toLowerCase()
          : "other",
      );
      if (
        text[at + spelled.length] === "\n" ||
        text.slice(at + spelled.length, at + spelled.length + 2) === "\r\n"
      ) {
        inv.lineBreaks.followedByNewline++;
      }
      if (pDepth > 0) inv.lineBreaks.insideParagraph++;
      else inv.lineBreaks.outsideParagraph++;
    }

    if (/^h[1-6]$/.test(name) && !closing) {
      inc(
        inv.headings.forms,
        `${name}:${params ? (paramForm(params) === "|uuid" ? "uuid" : "other-param") : "plain"}`,
      );
      const before = text.slice(0, at);
      let ctx = "other";
      if (pDepth > 0) ctx = "inside-[p]";
      else if (before.trim() === "") ctx = "field-start";
      else if (/\[\/p\]\s*$/i.test(before)) ctx = "after-[/p]";
      else if (/\n$/.test(before)) ctx = "after-newline";
      inc(inv.headings.context, ctx);
    }

    if (name === "url" && !closing) {
      inc(inv.links.forms, params ? `url${params[0]}` : "url");
      const target = params ? params.slice(1) : "";
      inc(
        inv.links.targetShape,
        !params
          ? "none"
          : /^https:\/\//i.test(target)
            ? "https"
            : /^http:\/\//i.test(target)
              ? "http"
              : target.startsWith("/")
                ? "relative"
                : "other",
      );
    }
  }
  if (pDepth !== 0) unbalanced = true;
  if (unbalanced) inv.paragraphs.unbalancedFields++;
  if (sawTag) inv.fieldsWithTags++;

  // Paragraph layout
  for (const m of text.matchAll(/\[\/p\]([ \t\r\n]*)\[p\]/gi))
    inc(inv.paragraphs.separators, wsKind(m[1]!.replace(/\r\n/g, "\n")));
  inv.paragraphs.emptyParagraphs += (text.match(/\[p\]\s*\[\/p\]/gi) ?? []).length;
  if (sawParagraph) {
    const outside = text.replace(/\[p\][\s\S]*?\[\/p\]/gi, "").trim();
    if (outside === "") inv.paragraphs.fieldsAllInParagraphs++;
    else inv.paragraphs.fieldsMixed++;
  } else inv.paragraphs.fieldsWithoutParagraphs++;

  // List item layout
  for (const m of text.matchAll(/\[\/li\]([ \t\r\n]*)\[li\]/gi))
    inc(inv.lists.itemSeparators, wsKind(m[1]!.replace(/\r\n/g, "\n")));

  // Mentions
  for (const m of text.matchAll(MENTION)) {
    if (!m[2]) {
      inv.mentions.bare++;
      continue;
    }
    const target = m[3] ?? "";
    // Type kept with its exact case: the editor writes "Article", the API may write a template name.
    const tm = /^([A-Za-z][A-Za-z0-9_-]{0,30}):(.+)$/.exec(target);
    if (tm) {
      inv.mentions.withTarget++;
      inc(inv.mentions.targetTypes, tm[1]!);
      inc(inv.mentions.targetIdShape, UUID.test(tm[2]!) ? "uuid" : "other");
    } else inv.mentions.otherTargetForms++;
  }

  inv.sidebarLines += (text.match(SIDEBAR) ?? []).length;
  inv.placeholderChars += (text.match(/[⟦⟧]/g) ?? []).length;

  // Typography (French): must survive conversion untouched
  const typo: [string, RegExp][] = [
    ["U+00A0 no-break space", /\u00a0/g],
    ["U+202F narrow no-break space", /\u202f/g],
    ["’ apostrophe", /\u2019/g],
    ["« »", /[\u00ab\u00bb]/g],
    ["– en dash", /\u2013/g],
    ["— em dash", /\u2014/g],
    ["… ellipsis", /\u2026/g],
  ];
  for (const [k, re] of typo) {
    const n = (text.match(re) ?? []).length;
    if (n) inc(inv.typography, k, n);
  }

  // Markdown-significant characters in plain text
  const plain = text.replace(MENTION, " ").replace(TAG, "\n");
  const md: [string, RegExp][] = [
    ["*", /\*/g],
    ["_", /_/g],
    ["`", /`/g],
    ["~", /~/g],
    ["\\", /\\/g],
    ["|", /\|/g],
    ["[ (not a tag)", /\[/g],
    ["] (not a tag)", /\]/g],
    ["# at line start", /^[ \t]*#/gm],
    ["> at line start", /^[ \t]*>/gm],
    ["- or + then space at line start", /^[ \t]*[-+] /gm],
    ["digits. at line start", /^[ \t]*\d+\. /gm],
    ["--- line", /^[ \t]*-{3,}[ \t]*$/gm],
  ];
  for (const [k, re] of md) {
    const n = (plain.match(re) ?? []).length;
    if (n) inc(inv.markdownChars, k, n);
  }
}

/** Record a string field the registry does NOT flag as BBCode, if it contains a known tag. */
export function scanUnflaggedField(inv: Inventory, field: string, text: string): void {
  for (const m of text.matchAll(TAG)) {
    if (KNOWN_TAGS.has(m[2]!.toLowerCase())) {
      inc(inv.unflaggedFieldsWithTags, field);
      return;
    }
  }
}

/** Everything except localOnly: safe to paste. */
export function shareable(
  inv: Inventory,
): Omit<Inventory, "localOnly"> & { unknownTags: { distinctNames: number; occurrences: number } } {
  const { localOnly, ...rest } = inv;
  const names = Object.values(localOnly.unknownTagNames);
  return {
    ...rest,
    unknownTags: { distinctNames: names.length, occurrences: names.reduce((a, b) => a + b, 0) },
  };
}
