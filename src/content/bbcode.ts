/**
 * BBCode ⇄ Markdown for World Anvil text fields (stage C).
 *
 * Guarantee: for every BBCode string `x`, with `v = bbcodeToMarkdown(x)`,
 *   markdownToBbcode(v.markdown, v.layout) === x
 * byte for byte. It holds by construction: every block is checked on the spot
 * and falls back to a placeholder `⟦raw BBCode⟧` when converting it back would
 * not give the same bytes; the whole field is checked again at the end.
 *
 * A field is a sequence of blocks, one per line (lists span several lines):
 *   [p]…[/p], separated by "\n"         ⇄  paragraphs separated by a blank line
 *   [br] inside a paragraph              ⇄  a line break ("\" alone = an empty line)
 *   [b]…[/b] [i]…[/i] [s]…[/s]           ⇄  **…** *…* ~~…~~
 *   [hN]…[/hN], [hN|<id>]…[/hN] (1–6)    ⇄  # … ######, "## Title {#<id>}"
 *   [ul]/[ol] with "- ", "-- ", "--- "   ⇄  "- " lists / "1. " lists, three levels
 *   [quote]…[/quote] on one line          ⇄  "> …"
 *   [hr] alone                            ⇄  ---
 *   --Key::Value-- alone                  ⇄  unchanged
 *   @[Name](Type:id) mentions             ⇄  unchanged, exact case kept
 * A run of empty paragraphs is one placeholder ⟦[p][/p]×N⟧. Any other block
 * that does not convert exactly (tables, centred text, check lists, loose
 * lines…) becomes ONE placeholder on its own line; the rest of the field stays
 * readable. Inline tags without a Markdown form ([u], [category:…], [color]…)
 * are placeholders around readable text. Text and French typography are never
 * altered. Only a field with no block at all (plain text) is in plain mode.
 *
 * Layout: the mode plus the blank characters around the field, taken from the
 * field's current text when writing, so a field keeps its own form.
 */

export type TextMode = "paragraph" | "plain";

export interface Layout {
  mode: TextMode;
  /** Blank characters before the first block (paragraph mode only). */
  lead: string;
  /** Blank characters after the last block (paragraph mode only). */
  trail: string;
}

/** Why a field is in plain mode. Names only, no content. */
export type FallbackReason = "no-block-tags" | "no-readable-block" | "paragraph-check-failed";

export interface MarkdownView {
  markdown: string;
  /** Layout to use when this Markdown is converted back. */
  layout: Layout;
  /** Shortcut for layout.mode. */
  mode: TextMode;
  /** True when some BBCode is shown as ⟦…⟧ placeholders. */
  hasPlaceholders: boolean;
  /** Raw BBCode held by each placeholder (for local diagnostics only; may hold user text). */
  placeholderRaws: string[];
  /** Why each placeholder was needed, as a rule name (no content), parallel to placeholderRaws. */
  placeholderShapes: string[];
  /** True when the whole field could only be shown raw. */
  rawFallback: boolean;
  /** Set when the field is in plain mode: why. */
  fallbackReason?: FallbackReason;
}

export const PH_OPEN = "⟦";
export const PH_CLOSE = "⟧";
export const PARAGRAPH: Layout = { mode: "paragraph", lead: "", trail: "" };
export const PLAIN: Layout = { mode: "plain", lead: "", trail: "" };

/** Mention: @[Display name](Type:id). Atomic in both directions. */
const MENTION_SRC = String.raw`@\[[^\]\n]{1,300}\]\([A-Za-z][A-Za-z0-9_-]{0,40}:[^)\s]{1,100}\)`;
const MENTION_AT = new RegExp(`^${MENTION_SRC}`);
export const MENTION_GLOBAL = new RegExp(
  String.raw`@\[([^\]\n]{1,300})\]\(([A-Za-z][A-Za-z0-9_-]{0,40}):([^)\s]{1,100})\)`,
  "g",
);
/** Element links written as tags: [category:<id>]…[/category], [timeline:<id>]…, [secret:<id>], [img:<id>|…]. */
const TAG_LINK_GLOBAL =
  /\[(category|timeline|secret|img):([A-Za-z0-9-]{1,100})(?:\|[^\]\n]{0,100})?\]/g;
/** A BBCode tag token (open, close or self-closing, with optional parameter). */
const TAG_AT = /^\[\/?[A-Za-z][A-Za-z0-9_-]{0,30}(?:[:=|][^\]\n]{0,300})?(?:\s*\/)?\]/;

/** Characters the Markdown side treats specially after a backslash. */
const ESCAPABLE = new Set(["\\", "*", "~", PH_OPEN, PH_CLOSE, "#", "-", ".", ">", "×"]);

/**
 * A sidebar key-value line, displayed by World Anvil as "Key: Value". Only the
 * exact form counts: "--", a key, "::", a value, "--", alone on its line. A
 * list sub-item such as "-- name : value" is not one.
 */
export const SIDEBAR_LINE = /^--[^\s:-][^\n]*?::[^\n]*?--$/;

const EMPTY_P = "[p][/p]";

// ---------------------------------------------------------------------------
// Placeholders

/** Placeholders made while converting, with the rule that required each. */
interface Collector {
  raws: string[];
  shapes: string[];
}
const collector = (): Collector => ({ raws: [], shapes: [] });
const absorb = (into: Collector, from: Collector) => {
  into.raws.push(...from.raws);
  into.shapes.push(...from.shapes);
};

function placeholder(raw: string, c: Collector, shape: string): string {
  c.raws.push(raw);
  c.shapes.push(shape);
  return PH_OPEN + raw.replace(/[\\⟧×]/g, (ch) => "\\" + ch) + PH_CLOSE;
}

/** A run of N ≥ 2 empty paragraphs, written compactly. */
function emptyRunPlaceholder(n: number, c: Collector): string {
  c.raws.push(Array<string>(n).fill(EMPTY_P).join("\n"));
  c.shapes.push("empty paragraphs");
  return `${PH_OPEN}${EMPTY_P}×${n}${PH_CLOSE}`;
}
const EMPTY_RUN = /^\[p\]\[\/p\]×([1-9]\d{0,5})$/;

/** Read a placeholder starting at `i` (which holds ⟦). Returns raw text and end index. */
function readPlaceholder(md: string, i: number): { raw: string; end: number } | undefined {
  let raw = "";
  let literal = "";
  for (let j = i + 1; j < md.length; j++) {
    const ch = md.charAt(j);
    if (ch === "\\" && j + 1 < md.length) {
      raw += md.charAt(j + 1);
      literal += ch + md.charAt(j + 1);
      j++;
    } else if (ch === PH_CLOSE) {
      // ⟦[p][/p]×N⟧ (unescaped ×) stands for N empty paragraphs, one per line.
      const run = EMPTY_RUN.exec(literal);
      if (run) raw = Array<string>(Number(run[1])).fill(EMPTY_P).join("\n");
      return { raw, end: j + 1 };
    } else {
      raw += ch;
      literal += ch;
    }
  }
  return undefined;
}

/** The raw text of `md` when `md` is exactly one placeholder. */
function singlePlaceholder(md: string): string | undefined {
  if (!md.startsWith(PH_OPEN)) return undefined;
  const p = readPlaceholder(md, 0);
  return p && p.end === md.length ? p.raw : undefined;
}

// ---------------------------------------------------------------------------
// BBCode → Markdown, inline

type BbToken =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string }
  | { kind: "tag"; value: string };

function tokenizeBbcode(bb: string): BbToken[] {
  const out: BbToken[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  for (let i = 0; i < bb.length;) {
    const rest = bb.slice(i);
    if (bb[i] === "@") {
      const m = MENTION_AT.exec(rest);
      if (m) {
        flush();
        out.push({ kind: "mention", value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (bb[i] === "[") {
      const m = TAG_AT.exec(rest);
      if (m) {
        flush();
        out.push({ kind: "tag", value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    text += bb.charAt(i);
    i++;
  }
  flush();
  return out;
}

type EmphasisKind = "b" | "i" | "s";
const EMPHASIS: Record<string, { md: string; open: boolean; kind: EmphasisKind }> = {
  "[b]": { md: "**", open: true, kind: "b" },
  "[/b]": { md: "**", open: false, kind: "b" },
  "[i]": { md: "*", open: true, kind: "i" },
  "[/i]": { md: "*", open: false, kind: "i" },
  "[s]": { md: "~~", open: true, kind: "s" },
  "[/s]": { md: "~~", open: false, kind: "s" },
};
const DELIM_TAG: Record<string, EmphasisKind> = { "**": "b", "*": "i", "~~": "s" };

/** Indexes of [b]/[i]/[s] tags that pair up properly (same kind, well nested). */
function matchedEmphasis(tokens: BbToken[]): Set<number> {
  const ok = new Set<number>();
  const stack: { kind: string; index: number }[] = [];
  tokens.forEach((t, index) => {
    if (t.kind !== "tag") return;
    const e = EMPHASIS[t.value];
    if (!e) return;
    if (e.open) stack.push({ kind: e.kind, index });
    else if (stack.at(-1)?.kind === e.kind) {
      ok.add(stack.pop()?.index ?? -1);
      ok.add(index);
    } else {
      stack.length = 0; // crossing tags: leave the rest as placeholders
    }
  });
  return ok;
}

/** Escape plain text. Level 0: only what must be escaped; level 1: every `*` and `~` too. */
function escapeText(s: string, level: 0 | 1): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const next = s.charAt(i + 1);
    if (ch === PH_OPEN || ch === PH_CLOSE) out += "\\" + ch;
    else if (ch === "\\" && (next === "" || ESCAPABLE.has(next))) out += "\\\\";
    else if ((ch === "*" || ch === "~") && level === 1) out += "\\" + ch;
    else out += ch;
  }
  return out;
}

interface InlineOptions {
  /** Paragraph: [br] becomes a line break. Plain: newlines are literal, [br] a placeholder. */
  mode: TextMode;
  escapeLevel: 0 | 1;
  /** Keep [br] as a placeholder. */
  brPlaceholder?: boolean;
  /** Keep [b]/[i]/[s] as placeholders (last resort before raw). */
  noEmphasis?: boolean;
}

const ATTEMPTS: Omit<InlineOptions, "mode">[] = [
  { escapeLevel: 0 },
  { escapeLevel: 1 },
  { escapeLevel: 0, brPlaceholder: true },
  { escapeLevel: 1, brPlaceholder: true },
  { escapeLevel: 1, brPlaceholder: true, noEmphasis: true },
];

/** Shape of an inline tag kept as a placeholder. */
function inlineShape(tag: string, o: InlineOptions): string {
  if (o.mode === "plain") return "tag in a plain-mode field";
  if (EMPHASIS[tag]) return "unpaired or crossing [b]/[i]/[s]";
  if (tag === "[br]") return "[br] kept as placeholder";
  return "inline tag without a Markdown form";
}

/** Marks an empty line inside a paragraph (e.g. "[br][br]", or a [br] at its start or end). */
const EMPTY_LINE_MARK = "\\";

function inlineToMarkdown(bb: string, o: InlineOptions, c: Collector): string {
  const tokens = tokenizeBbcode(bb);
  const matched = o.noEmphasis ? new Set<number>() : matchedEmphasis(tokens);
  let md = "";
  tokens.forEach((t, i) => {
    if (t.kind === "text") md += escapeText(t.value, o.escapeLevel);
    else if (t.kind === "mention") md += t.value;
    else if (matched.has(i)) md += EMPHASIS[t.value]?.md ?? t.value;
    else if (o.mode === "paragraph" && t.value === "[br]" && !o.brPlaceholder) md += "\n";
    else md += placeholder(t.value, c, inlineShape(t.value, o));
  });
  // Inside a paragraph, an empty line is a line holding only "\", so it cannot
  // be read as a paragraph break.
  if (o.mode === "paragraph" && md.includes("\n")) {
    md = md
      .split("\n")
      .map((l) => (l === "" ? EMPTY_LINE_MARK : l))
      .join("\n");
  }
  return md;
}

// ---------------------------------------------------------------------------
// Markdown → BBCode, inline

type MdToken =
  | { kind: "text"; value: string }
  | { kind: "raw"; value: string } // placeholder or mention: copied as is
  | { kind: "delim"; value: "**" | "*" | "~~" }
  | { kind: "newline" };

function tokenizeMarkdown(md: string, mode: TextMode): MdToken[] {
  const out: MdToken[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  for (let i = 0; i < md.length;) {
    const ch = md.charAt(i);
    // A line holding only "\" is an empty line inside a paragraph.
    if (
      ch === "\\" &&
      mode === "paragraph" &&
      (i === 0 || md.charAt(i - 1) === "\n") &&
      (i + 1 === md.length || md.charAt(i + 1) === "\n")
    ) {
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < md.length && ESCAPABLE.has(md.charAt(i + 1))) {
      text += md.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === PH_OPEN) {
      const p = readPlaceholder(md, i);
      if (p) {
        flush();
        out.push({ kind: "raw", value: p.raw });
        i = p.end;
        continue;
      }
    }
    if (ch === "@") {
      const m = MENTION_AT.exec(md.slice(i));
      if (m) {
        flush();
        out.push({ kind: "raw", value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "*") {
      flush();
      const two = md.charAt(i + 1) === "*";
      out.push({ kind: "delim", value: two ? "**" : "*" });
      i += two ? 2 : 1;
      continue;
    }
    if (ch === "~" && md.charAt(i + 1) === "~") {
      flush();
      out.push({ kind: "delim", value: "~~" });
      i += 2;
      continue;
    }
    if (ch === "\n" && mode === "paragraph") {
      flush();
      out.push({ kind: "newline" });
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function inlineToBbcode(md: string, mode: TextMode): string {
  const tokens = tokenizeMarkdown(md, mode);
  // Pair delimiters: a delimiter closes the innermost open one of the same kind.
  const role = new Map<number, "open" | "close">();
  const stack: { value: string; index: number }[] = [];
  tokens.forEach((t, index) => {
    if (t.kind !== "delim") return;
    const top = stack.at(-1);
    if (top && top.value === t.value) {
      role.set(top.index, "open");
      role.set(index, "close");
      stack.pop();
    } else stack.push({ value: t.value, index });
  });
  let bb = "";
  tokens.forEach((t, index) => {
    if (t.kind === "text" || t.kind === "raw") bb += t.value;
    else if (t.kind === "newline") bb += "[br]";
    else {
      const r = role.get(index);
      const tag = DELIM_TAG[t.value] ?? "b";
      bb += r === "open" ? `[${tag}]` : r === "close" ? `[/${tag}]` : t.value;
    }
  });
  return bb;
}

// ---------------------------------------------------------------------------
// Blocks

const P_BLOCK = /^\[p\]([\s\S]*)\[\/p\]$/;
const H_BLOCK = /^\[h([1-6])(?:\|([A-Za-z0-9-]{1,100}))?\]([\s\S]*)\[\/h\1\]$/;
const QUOTE_BLOCK = /^\[quote\]([\s\S]*)\[\/quote\]$/;
const MD_HEADING = /^(#{1,6}) ([^\n]*?)(?: \{#([A-Za-z0-9-]{1,100})\})?$/;
const LISTS = { "[ul]": "[/ul]", "[ol]": "[/ol]" } as const;
type ListOpen = keyof typeof LISTS;
/** Editor list item: "- text", "-- text", "--- text" (three levels). */
const BB_ITEM = /^(-{1,3}) ([\s\S]*)$/;
/** Markdown bullet item: "- text" indented by 0, 2 or 4 spaces. */
const MD_BULLET = /^((?: {2}){0,2})- (.*)$/;
/** Markdown numbered item: "1. text" indented by 0, 3 or 6 spaces. */
const MD_NUMBERED = /^((?: {3}){0,2})(\d{1,4})\. (.*)$/;

const isSidebarBlock = (block: string) => block.split("\n").every((l) => SIDEBAR_LINE.test(l));
const allLines = (block: string, re: RegExp) => block.split("\n").every((l) => re.test(l));

/** Markdown block → BBCode block. */
function mdBlockToBbcode(block: string): string {
  const raw = singlePlaceholder(block);
  if (raw !== undefined) return raw;
  if (block === "---") return "[hr]";
  if (isSidebarBlock(block)) return block;
  const bullets = allLines(block, MD_BULLET);
  if (bullets || allLines(block, MD_NUMBERED)) {
    const re = bullets ? MD_BULLET : MD_NUMBERED;
    const width = bullets ? 2 : 3;
    const items = block.split("\n").map((l) => {
      const m = re.exec(l);
      const level = (m?.[1]?.length ?? 0) / width + 1;
      const text = (bullets ? m?.[2] : m?.[3]) ?? "";
      return `${"-".repeat(level)} ${inlineToBbcode(text, "plain")}`;
    });
    const [open, close] = bullets ? ["[ul]", "[/ul]"] : ["[ol]", "[/ol]"];
    return `${open}\n${items.join("\n")}\n${close}`;
  }
  if (allLines(block, /^> /)) {
    const inner = block
      .split("\n")
      .map((l) => l.slice(2))
      .join("\n");
    return `[quote]${inlineToBbcode(inner, "paragraph")}[/quote]`;
  }
  const h = MD_HEADING.exec(block);
  if (h) {
    const level = (h[1] ?? "#").length;
    const id = h[3] ? `|${h[3]}` : "";
    return `[h${level}${id}]${inlineToBbcode(h[2] ?? "", "paragraph")}[/h${level}]`;
  }
  return `[p]${inlineToBbcode(block, "paragraph")}[/p]`;
}

/** A converted block must not blur the blank-line separators and must convert back exactly. */
function safeBlock(md: string, block: string): boolean {
  return (
    md.length > 0 &&
    md.trim() !== "" &&
    !md.includes("\n\n") &&
    !md.startsWith("\n") &&
    !md.endsWith("\n") &&
    mdBlockToBbcode(md) === block
  );
}

/** Escape what, at the start of a line, would read as a heading, list, quote, rule or sidebar line. */
function escapeLineStarts(md: string): string {
  return md
    .split("\n")
    .map((l) => {
      if (/^\d{1,4}\. /.test(l.trimStart())) return l.replace(/^(\s*\d{1,4})\./, "$1\\.");
      if (
        /^#{1,6} /.test(l) ||
        /^ *- /.test(l) ||
        /^> /.test(l) ||
        l === "---" ||
        SIDEBAR_LINE.test(l)
      ) {
        return l.replace(/^( *)/, "$1\\");
      }
      return l;
    })
    .join("\n");
}

/** Why a whole block stays a placeholder, as a rule name (no content). */
function blockShape(block: string): string {
  if (block === EMPTY_P) return "empty paragraph";
  if (/^\[p\]\s+\[\/p\]$/.test(block)) return "blank paragraph";
  if (/^\[h[1-6]?\|/.test(block) || /^\[h\]/.test(block))
    return "heading with an unknown parameter";
  if (/^\[h[1-6]\]/.test(block)) return "heading that did not convert back exactly";
  if (/^\[(ul|ol)\]/.test(block)) return "list in another layout";
  if (/^\[\] /.test(block)) return "check list";
  if (/\[\/(p|h[1-6])\][ \t]*\S/.test(block)) return "several blocks on one line";
  if (/^\[p\]/.test(block) && /\[(ul|ol|h[1-6]|p)[\]|]/.test(block.slice(3))) {
    return "paragraph containing a block tag";
  }
  if (/^\[p\]/.test(block)) return "paragraph that did not convert back exactly";
  if (block.includes("\n")) return "lines outside blocks";
  if (/^-{1,3} /.test(block)) return "list item outside a list";
  if (block.startsWith("[")) return "line wrapped in another tag";
  return block === "" ? "empty line" : "text line outside blocks";
}

type Block =
  | { kind: "line"; text: string }
  | { kind: "empty-run"; count: number }
  | { kind: "loose"; text: string };

/** One block of a paragraph-mode field → Markdown (a placeholder when not exact). */
function blockToMarkdown(block: Block, c: Collector): string {
  if (block.kind === "empty-run") {
    return block.count === 1
      ? placeholder(EMPTY_P, c, "empty paragraph")
      : emptyRunPlaceholder(block.count, c);
  }
  const text = block.text;
  if (block.kind === "loose") return placeholder(text, c, blockShape(text));
  if (text === "[hr]") return "---";
  if (SIDEBAR_LINE.test(text) && mdBlockToBbcode(text) === text) return text;

  // Lists: [ul] or [ol], one item per line: "- ", "-- ", "--- ".
  const listOpen = (Object.keys(LISTS) as ListOpen[]).find(
    (o) => text.startsWith(o + "\n") && text.endsWith("\n" + LISTS[o]),
  );
  if (listOpen) {
    const lines = text.slice(listOpen.length + 1, -(LISTS[listOpen].length + 1)).split("\n");
    if (lines.length && lines.every((l) => BB_ITEM.test(l))) {
      for (const a of ATTEMPTS) {
        const local = collector();
        const counters = [0, 0, 0];
        const md = lines
          .map((l) => {
            const m = BB_ITEM.exec(l);
            const level = m?.[1]?.length ?? 1;
            const item = inlineToMarkdown(m?.[2] ?? "", { mode: "plain", ...a }, local);
            if (listOpen === "[ul]") return `${"  ".repeat(level - 1)}- ${item}`;
            counters[level - 1] = (counters[level - 1] ?? 0) + 1;
            for (let k = level; k < 3; k++) counters[k] = 0;
            return `${"   ".repeat(level - 1)}${counters[level - 1]}. ${item}`;
          })
          .join("\n");
        if (safeBlock(md, text)) {
          absorb(c, local);
          return md;
        }
      }
    }
    return placeholder(text, c, blockShape(text));
  }

  const pInner = P_BLOCK.exec(text)?.[1];
  const h = H_BLOCK.exec(text);
  const q = QUOTE_BLOCK.exec(text)?.[1];
  const isP = pInner !== undefined && !/\[\/?p\]/.test(pInner) && pInner.trim() !== "";
  const source = isP ? pInner : (h?.[3] ?? q);
  if (source !== undefined && (isP || h || !/\[\/?quote\]/.test(q ?? ""))) {
    for (const a of ATTEMPTS) {
      const local = collector();
      const inner = inlineToMarkdown(source, { mode: "paragraph", ...a }, local);
      // Escape line starts only when the unescaped text would read as something else.
      let candidates: string[];
      if (isP) candidates = [inner, escapeLineStarts(inner)];
      else if (h) candidates = [`${"#".repeat(Number(h[1]))} ${inner}${h[2] ? ` {#${h[2]}}` : ""}`];
      else {
        const quoted = (s: string) =>
          s
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
        candidates = [quoted(inner), quoted(escapeLineStarts(inner))];
      }
      for (const md of candidates) {
        if (safeBlock(md, text)) {
          absorb(c, local);
          return md;
        }
      }
    }
  }
  return placeholder(text, c, blockShape(text));
}

/** A line that may stand as a block by itself. */
const isBlockLine = (l: string) =>
  SIDEBAR_LINE.test(l) || (l.startsWith("[") && l.endsWith("]") && !/^\[\] /.test(l));

/**
 * Split a field into blocks: tag-wrapped lines, [ul]/[ol] lists, sidebar lines,
 * runs of empty paragraphs, and runs of other lines (kept as one placeholder
 * each). Blank characters around the field are kept apart.
 */
function splitBlocks(bb: string): { lead: string; trail: string; blocks: Block[] } | undefined {
  const lead = /^[ \t\r\n]*/.exec(bb)?.[0] ?? "";
  const core = bb.slice(lead.length);
  const trail = /[ \t\r\n]*$/.exec(core)?.[0] ?? "";
  const body = core.slice(0, core.length - trail.length);
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let loose: string[] = [];
  const flushLoose = () => {
    if (loose.length) blocks.push({ kind: "loose", text: loose.join("\n") });
    loose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const close = LISTS[l as ListOpen] as string | undefined;
    if (close) {
      const end = lines.indexOf(close, i + 1);
      if (end > i) {
        flushLoose();
        blocks.push({ kind: "line", text: lines.slice(i, end + 1).join("\n") });
        i = end;
        continue;
      }
    }
    if (l === EMPTY_P) {
      flushLoose();
      const last = blocks.at(-1);
      if (last?.kind === "empty-run") last.count++;
      else blocks.push({ kind: "empty-run", count: 1 });
      continue;
    }
    if (isBlockLine(l)) {
      flushLoose();
      blocks.push({ kind: "line", text: l });
    } else loose.push(l);
  }
  flushLoose();
  // A field with no block at all (plain text) reads better in plain mode.
  return blocks.some((b) => b.kind !== "loose") ? { lead, trail, blocks } : undefined;
}

// ---------------------------------------------------------------------------
// Public API

/** Private-use character marking protected placeholders while splitting blocks. */
const SENTINEL = "";
const SENTINEL_RE = /(\d+)/g;

export function bbcodeToMarkdown(bb: string): MarkdownView {
  const view = (
    markdown: string,
    layout: Layout,
    c: Collector,
    extra: Partial<MarkdownView> = {},
  ): MarkdownView => ({
    markdown,
    layout,
    mode: layout.mode,
    hasPlaceholders: c.raws.length > 0,
    placeholderRaws: c.raws,
    placeholderShapes: c.shapes,
    rawFallback: false,
    ...extra,
  });
  if (bb === "") return view("", PARAGRAPH, collector());

  let reason: FallbackReason = "no-block-tags";
  const split = /\[p\]|\[h[1-6]?[\]|]|\[ul\]|\[ol\]|\[quote\]|\[hr\]/.test(bb)
    ? splitBlocks(bb)
    : undefined;
  if (split) {
    const layout: Layout = { mode: "paragraph", lead: split.lead, trail: split.trail };
    const c = collector();
    const mds = split.blocks.map((b) => blockToMarkdown(b, c));
    const markdown = mds.join("\n\n");
    // Paragraph mode only pays off when at least one block reads as text; otherwise plain mode
    // (tags as placeholders around readable text) is easier to read.
    const readable = mds.some((md) => singlePlaceholder(md) === undefined);
    if (readable && markdownToBbcode(markdown, layout) === bb) return view(markdown, layout, c);
    // Should not happen (every block is checked); keep paragraph mode with every block raw.
    const r = collector();
    const raw = split.blocks
      .map((b) =>
        b.kind === "empty-run"
          ? blockToMarkdown(b, r)
          : placeholder(b.text, r, "block kept raw after a whole-field check"),
      )
      .join("\n\n");
    if (readable && markdownToBbcode(raw, layout) === bb) return view(raw, layout, r);
    reason = readable ? "paragraph-check-failed" : "no-readable-block";
  }

  for (const a of ATTEMPTS) {
    const c = collector();
    const md = inlineToMarkdown(bb, { mode: "plain", ...a }, c);
    if (markdownToBbcode(md, PLAIN) === bb) return view(md, PLAIN, c, { fallbackReason: reason });
  }
  const c = collector();
  return view(placeholder(bb, c, "whole field"), PLAIN, c, {
    rawFallback: true,
    fallbackReason: reason,
  });
}

export function markdownToBbcode(md: string, layout: Layout | TextMode): string {
  const l: Layout = typeof layout === "string" ? { mode: layout, lead: "", trail: "" } : layout;
  // Plain mode keeps every byte, CRLF included. Paragraph mode accepts Markdown typed with CRLF.
  if (l.mode === "plain") return inlineToBbcode(md, "plain");
  const text = md.replace(/\r\n/g, "\n");
  if (text.trim() === "") return "";

  // Protect placeholders (they may contain blank lines) before splitting into blocks.
  const saved: string[] = [];
  let protectedText = "";
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.has(text.charAt(i + 1))) {
      protectedText += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] === PH_OPEN) {
      const p = readPlaceholder(text, i);
      if (p) {
        saved.push(text.slice(i, p.end));
        protectedText += `${SENTINEL}${saved.length - 1}${SENTINEL}`;
        i = p.end;
        continue;
      }
    }
    protectedText += text.charAt(i);
    i++;
  }
  const restore = (s: string) => s.replace(SENTINEL_RE, (_, n: string) => saved[Number(n)] ?? "");

  const blocks = protectedText
    .split(/\n{2,}/)
    .filter((b) => b !== "")
    .map((b) => mdBlockToBbcode(restore(b)));
  return l.lead + blocks.join("\n") + l.trail;
}

/** Layout for writing Markdown into a field that currently holds `current`. */
export function writeLayoutFor(current: string | undefined): Layout {
  if (current === undefined || current === "") return PARAGRAPH;
  return bbcodeToMarkdown(current).layout;
}

// ---------------------------------------------------------------------------
// Helpers for writes

/**
 * Element references inside text: @[Name](Type:id) mentions, and tag links
 * [category:<id>], [timeline:<id>], [secret:<id>], [img:<id>|…]. Type keeps its exact case.
 */
export function mentionsIn(bb: string): { type: string; id: string }[] {
  const mentions = [...bb.matchAll(MENTION_GLOBAL)].map((m) => ({
    type: m[2] ?? "",
    id: m[3] ?? "",
  }));
  const tags = [...bb.matchAll(TAG_LINK_GLOBAL)].map((m) => ({ type: m[1] ?? "", id: m[2] ?? "" }));
  return [...mentions, ...tags];
}

/** Count of each structural item: tag names (lowercase), mentions, sidebar lines. */
export function structureCounts(bb: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const withoutMentions = bb.replace(MENTION_GLOBAL, () => {
    add("mention");
    return " ";
  });
  for (const m of withoutMentions.matchAll(
    /\[([A-Za-z][A-Za-z0-9_-]{0,30})(?:[:=|][^\]\n]{0,300})?(?:\s*\/)?\]/g,
  )) {
    add(`[${(m[1] ?? "").toLowerCase()}]`);
  }
  const sidebarLines = bb.split("\n").filter((l) => SIDEBAR_LINE.test(l)).length;
  for (let n = 0; n < sidebarLines; n++) add("--key::value-- line");
  return counts;
}

/** Items present before and fewer (or absent) after, e.g. "[section]: 2 → 0". */
export function missingStructure(before: string, after: string): string[] {
  const b = structureCounts(before);
  const a = structureCounts(after);
  return Object.entries(b)
    .filter(([k, n]) => (a[k] ?? 0) < n)
    .map(([k, n]) => `${k}: ${n} → ${a[k] ?? 0}`);
}
