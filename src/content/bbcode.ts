/**
 * BBCode ⇄ Markdown for World Anvil text fields (stage C).
 *
 * Guarantee: for every BBCode string `x`, with `v = bbcodeToMarkdown(x)`,
 *   markdownToBbcode(v.markdown, v.layout) === x
 * byte for byte. It holds by construction: every converted block is checked
 * on the spot and falls back to a placeholder `⟦raw BBCode⟧` when converting it
 * back would not give the same bytes; the whole field is checked again at the
 * end, with two last fallbacks (plain mode, then the whole field raw).
 *
 * Converted (the forms the World Anvil editor writes):
 *   [p]…[/p] paragraphs, separated by "\n"   ⇄  paragraphs separated by a blank line
 *   [br] inside a paragraph                   ⇄  a line break inside a paragraph
 *   [b]…[/b]  [i]…[/i]                         ⇄  **…**  *…*
 *   [h1]…[/h1] … [h6], own line                ⇄  # … ######
 *   [h2|<id>]…[/h2]                            ⇄  ## … {#<id>}
 *   [ul]\n- item\n-- sub-item\n[/ul]           ⇄  - item / ␣␣- sub-item
 *   @[Name](Type:id) mentions                  ⇄  unchanged, exact case kept
 *   --Key::Value-- lines, own line             ⇄  unchanged
 * Everything else (unknown tags, tags with other parameters, uppercase
 * spellings, empty paragraphs, odd layouts) becomes a placeholder and is
 * written back exactly. Text, including French typography, is never altered.
 *
 * Layout: the mode plus the blank characters around the field. It is taken
 * from the field's current text when writing, so a field keeps its own form
 * (e.g. a trailing newline); new text uses the editor's paragraph form.
 */

export type TextMode = "paragraph" | "plain";

export interface Layout {
  mode: TextMode;
  /** Blank characters before the first block (paragraph mode only). */
  lead: string;
  /** Blank characters after the last block (paragraph mode only). */
  trail: string;
}

/** Why a field could not be shown in paragraph mode. Names only, no content. */
export type FallbackReason =
  | "no-block-tags"
  | "line-outside-blocks"
  | "empty-line"
  | "unclosed-list"
  | "paragraph-check-failed";

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
  /** True when the whole field could only be shown raw. */
  rawFallback: boolean;
  /** Set when the field is in plain mode: why paragraph mode was not possible. */
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
/** A BBCode tag token (open, close or self-closing, with optional parameter). */
const TAG_AT = /^\[\/?[A-Za-z][A-Za-z0-9_-]{0,30}(?:[:=|][^\]\n]{0,300})?(?:\s*\/)?\]/;

/** Characters the Markdown side treats specially after a backslash. */
const ESCAPABLE = new Set(["\\", "*", PH_OPEN, PH_CLOSE, "#", "-"]);

/**
 * A sidebar key-value line, displayed by World Anvil as "Key: Value". Only the
 * exact form counts: "--", a key, "::", a value, "--", alone on its line. A
 * list sub-item such as "-- name : value" is not one.
 */
export const SIDEBAR_LINE = /^--[^\s:-][^\n]*?::[^\n]*?--$/;

// ---------------------------------------------------------------------------
// Placeholders

function placeholder(raw: string, raws: string[]): string {
  raws.push(raw);
  return PH_OPEN + raw.replace(/[\\⟧]/g, (c) => "\\" + c) + PH_CLOSE;
}

/** Read a placeholder starting at `i` (which holds ⟦). Returns raw text and end index. */
function readPlaceholder(md: string, i: number): { raw: string; end: number } | undefined {
  let raw = "";
  for (let j = i + 1; j < md.length; j++) {
    const c = md.charAt(j);
    if (c === "\\" && j + 1 < md.length) {
      raw += md.charAt(j + 1);
      j++;
    } else if (c === PH_CLOSE) {
      return { raw, end: j + 1 };
    } else raw += c;
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

const EMPHASIS: Record<string, { md: string; open: boolean; kind: "b" | "i" }> = {
  "[b]": { md: "**", open: true, kind: "b" },
  "[/b]": { md: "**", open: false, kind: "b" },
  "[i]": { md: "*", open: true, kind: "i" },
  "[/i]": { md: "*", open: false, kind: "i" },
};

/** Indexes of [b]/[i] tags that pair up properly (same kind, well nested). */
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

/** Escape plain text. Level 0: only what must be escaped; level 1: every `*` too. */
function escapeText(s: string, level: 0 | 1): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const next = s.charAt(i + 1);
    if (c === PH_OPEN || c === PH_CLOSE) out += "\\" + c;
    else if (c === "\\" && (next === "" || ESCAPABLE.has(next))) out += "\\\\";
    else if (c === "*" && level === 1) out += "\\*";
    else out += c;
  }
  return out;
}

interface InlineOptions {
  /** Paragraph: [br] becomes a line break. Plain: newlines are literal, [br] a placeholder. */
  mode: TextMode;
  escapeLevel: 0 | 1;
  /** Keep [br] as a placeholder (e.g. a trailing or doubled line break). */
  brPlaceholder?: boolean;
  /** Keep [b]/[i] as placeholders (last resort before raw). */
  noEmphasis?: boolean;
}

const ATTEMPTS: Omit<InlineOptions, "mode">[] = [
  { escapeLevel: 0 },
  { escapeLevel: 1 },
  { escapeLevel: 0, brPlaceholder: true },
  { escapeLevel: 1, brPlaceholder: true },
  { escapeLevel: 1, brPlaceholder: true, noEmphasis: true },
];

function inlineToMarkdown(bb: string, o: InlineOptions, raws: string[]): string {
  const tokens = tokenizeBbcode(bb);
  const matched = o.noEmphasis ? new Set<number>() : matchedEmphasis(tokens);
  let md = "";
  tokens.forEach((t, i) => {
    if (t.kind === "text") md += escapeText(t.value, o.escapeLevel);
    else if (t.kind === "mention") md += t.value;
    else if (matched.has(i)) md += EMPHASIS[t.value]?.md ?? t.value;
    else if (o.mode === "paragraph" && t.value === "[br]" && !o.brPlaceholder) md += "\n";
    else md += placeholder(t.value, raws);
  });
  return md;
}

// ---------------------------------------------------------------------------
// Markdown → BBCode, inline

type MdToken =
  | { kind: "text"; value: string }
  | { kind: "raw"; value: string } // placeholder or mention: copied as is
  | { kind: "delim"; value: "**" | "*" }
  | { kind: "newline" };

function tokenizeMarkdown(md: string, mode: TextMode): MdToken[] {
  const out: MdToken[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  for (let i = 0; i < md.length;) {
    const c = md.charAt(i);
    if (c === "\\" && i + 1 < md.length && ESCAPABLE.has(md.charAt(i + 1))) {
      text += md.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === PH_OPEN) {
      const p = readPlaceholder(md, i);
      if (p) {
        flush();
        out.push({ kind: "raw", value: p.raw });
        i = p.end;
        continue;
      }
    }
    if (c === "@") {
      const m = MENTION_AT.exec(md.slice(i));
      if (m) {
        flush();
        out.push({ kind: "raw", value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "*") {
      flush();
      if (md.charAt(i + 1) === "*") {
        out.push({ kind: "delim", value: "**" });
        i += 2;
      } else {
        out.push({ kind: "delim", value: "*" });
        i += 1;
      }
      continue;
    }
    if (c === "\n" && mode === "paragraph") {
      flush();
      out.push({ kind: "newline" });
      i++;
      continue;
    }
    text += c;
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
      const tag = t.value === "**" ? "b" : "i";
      bb += r === "open" ? `[${tag}]` : r === "close" ? `[/${tag}]` : t.value;
    }
  });
  return bb;
}

// ---------------------------------------------------------------------------
// Blocks (paragraph mode)

const P_BLOCK = /^\[p\]([\s\S]*)\[\/p\]$/;
const H_BLOCK = /^\[h([1-6])(?:\|([A-Za-z0-9-]{1,100}))?\]([\s\S]*)\[\/h\1\]$/;
const MD_HEADING = /^(#{1,6}) ([^\n]*?)(?: \{#([A-Za-z0-9-]{1,100})\})?$/;
const LIST_OPEN = "[ul]";
const LIST_CLOSE = "[/ul]";
/** Editor list item: "- text" (level 1) or "-- text" (level 2). */
const BB_ITEM = /^(--?) ([\s\S]*)$/;
/** Markdown list item: "- text" (level 1) or "  - text" (level 2). */
const MD_ITEM = /^( {2})?- (.*)$/;

const isSidebarBlock = (block: string) => block.split("\n").every((l) => SIDEBAR_LINE.test(l));
const isListBlock = (block: string) => block.split("\n").every((l) => MD_ITEM.test(l));

/** Markdown block → BBCode block. */
function mdBlockToBbcode(block: string): string {
  const raw = singlePlaceholder(block);
  if (raw !== undefined) return raw;
  if (isSidebarBlock(block)) return block;
  if (isListBlock(block)) {
    const items = block.split("\n").map((l) => {
      const m = MD_ITEM.exec(l);
      return `${m?.[1] ? "--" : "-"} ${inlineToBbcode(m?.[2] ?? "", "plain")}`;
    });
    return `${LIST_OPEN}\n${items.join("\n")}\n${LIST_CLOSE}`;
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
    !md.includes("\n\n") &&
    !md.startsWith("\n") &&
    !md.endsWith("\n") &&
    mdBlockToBbcode(md) === block
  );
}

/** Escape what, at the start of a line, would read as a heading, a list item or a sidebar line. */
function escapeLineStarts(md: string): string {
  return md
    .split("\n")
    .map((l) =>
      /^#{1,6} /.test(l) || /^( {2})?- /.test(l) || SIDEBAR_LINE.test(l)
        ? l.replace(/^( *)/, "$1\\")
        : l,
    )
    .join("\n");
}

/** One block of a paragraph-mode field → Markdown (a placeholder when not exact). */
function blockToMarkdown(block: string, raws: string[]): string {
  if (SIDEBAR_LINE.test(block) && mdBlockToBbcode(block) === block) return block;

  // Lists: [ul]\n- item\n-- sub-item\n[/ul]
  if (block.startsWith(LIST_OPEN + "\n") && block.endsWith("\n" + LIST_CLOSE)) {
    const lines = block.slice(LIST_OPEN.length + 1, -(LIST_CLOSE.length + 1)).split("\n");
    if (lines.length && lines.every((l) => BB_ITEM.test(l))) {
      for (const a of ATTEMPTS) {
        const local: string[] = [];
        const md = lines
          .map((l) => {
            const m = BB_ITEM.exec(l);
            const text = inlineToMarkdown(m?.[2] ?? "", { mode: "plain", ...a }, local);
            return `${m?.[1] === "--" ? "  - " : "- "}${text}`;
          })
          .join("\n");
        if (safeBlock(md, block)) {
          raws.push(...local);
          return md;
        }
      }
    }
    return placeholder(block, raws);
  }

  const pInner = P_BLOCK.exec(block)?.[1];
  const h = H_BLOCK.exec(block);
  const isP = pInner !== undefined && !/\[\/?p\]/.test(pInner);
  const source = isP ? pInner : h?.[3];
  if (source !== undefined) {
    for (const a of ATTEMPTS) {
      const local: string[] = [];
      const inner = inlineToMarkdown(source, { mode: "paragraph", ...a }, local);
      // Escape line starts only when the unescaped text would read as something else.
      const candidates = isP
        ? [inner, escapeLineStarts(inner)]
        : [`${"#".repeat(Number(h?.[1]))} ${inner}${h?.[2] ? ` {#${h[2]}}` : ""}`];
      for (const md of candidates) {
        if (safeBlock(md, block)) {
          raws.push(...local);
          return md;
        }
      }
    }
  }
  return placeholder(block, raws);
}

/**
 * Split a field written in the editor's layout into blocks: [p] lines, heading
 * lines, [ul]…[/ul] lists, sidebar lines and other tag-wrapped lines; blank
 * characters around the field are kept apart.
 */
function paragraphBlocks(
  bb: string,
): { lead: string; trail: string; blocks: string[] } | FallbackReason {
  const lead = /^[ \t\r\n]*/.exec(bb)?.[0] ?? "";
  const core = bb.slice(lead.length);
  const trail = /[ \t\r\n]*$/.exec(core)?.[0] ?? "";
  const body = core.slice(0, core.length - trail.length);
  if (!/\[p\]|\[h[1-6][\]|]|\[ul\]/.test(body)) return "no-block-tags";
  const lines = body.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === LIST_OPEN) {
      const end = lines.indexOf(LIST_CLOSE, i + 1);
      if (end < 0) return "unclosed-list";
      blocks.push(lines.slice(i, end + 1).join("\n"));
      i = end;
      continue;
    }
    if (l === "") return "empty-line";
    if (SIDEBAR_LINE.test(l) || (l.startsWith("[") && l.endsWith("]"))) blocks.push(l);
    else return "line-outside-blocks";
  }
  return { lead, trail, blocks };
}

// ---------------------------------------------------------------------------
// Public API

/** Private-use character marking protected placeholders while splitting blocks. */
const SENTINEL = "\uE000";
const SENTINEL_RE = /\uE000(\d+)\uE000/g;

export function bbcodeToMarkdown(bb: string): MarkdownView {
  const view = (
    markdown: string,
    layout: Layout,
    raws: string[],
    extra: Partial<MarkdownView> = {},
  ): MarkdownView => ({
    markdown,
    layout,
    mode: layout.mode,
    hasPlaceholders: raws.length > 0,
    placeholderRaws: raws,
    rawFallback: false,
    ...extra,
  });
  if (bb === "") return view("", PARAGRAPH, []);

  const split = paragraphBlocks(bb);
  let reason: FallbackReason;
  if (typeof split === "string") reason = split;
  else {
    const raws: string[] = [];
    const markdown = split.blocks.map((b) => blockToMarkdown(b, raws)).join("\n\n");
    const layout: Layout = { mode: "paragraph", lead: split.lead, trail: split.trail };
    if (markdownToBbcode(markdown, layout) === bb) return view(markdown, layout, raws);
    reason = "paragraph-check-failed";
  }

  for (const a of ATTEMPTS) {
    const raws: string[] = [];
    const md = inlineToMarkdown(bb, { mode: "plain", ...a }, raws);
    if (markdownToBbcode(md, PLAIN) === bb)
      return view(md, PLAIN, raws, { fallbackReason: reason });
  }
  const raws: string[] = [];
  return view(placeholder(bb, raws), PLAIN, raws, { rawFallback: true, fallbackReason: reason });
}

export function markdownToBbcode(md: string, layout: Layout | TextMode): string {
  const l: Layout = typeof layout === "string" ? { mode: layout, lead: "", trail: "" } : layout;
  // Plain mode keeps every byte, CRLF included. Paragraph mode (the editor's
  // form, which never holds CR inside the text) accepts Markdown typed with CRLF.
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

/** Mentions in a BBCode string: type (exact case) and id. */
export function mentionsIn(bb: string): { type: string; id: string }[] {
  return [...bb.matchAll(MENTION_GLOBAL)].map((m) => ({ type: m[2] ?? "", id: m[3] ?? "" }));
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
