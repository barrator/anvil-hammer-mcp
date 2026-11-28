/**
 * BBCode ⇄ Markdown for World Anvil text fields (stage C).
 *
 * Guarantee: for every BBCode string `x`,
 *   markdownToBbcode(bbcodeToMarkdown(x).markdown, bbcodeToMarkdown(x).mode) === x
 * byte for byte. It holds by construction: every converted piece is checked
 * on the spot, and falls back to a placeholder `⟦raw BBCode⟧` when converting
 * it back would not give the same bytes. The whole field is checked again at
 * the end, with two last fallbacks (plain mode, then the whole field raw).
 *
 * Converted (the forms the World Anvil editor writes):
 *   [p]…[/p] paragraphs, separated by "\n"   ⇄  paragraphs separated by a blank line
 *   [br] inside a paragraph                   ⇄  a line break inside a paragraph
 *   [b]…[/b]  [i]…[/i]                         ⇄  **…**  *…*
 *   [h1]…[/h1] … [h6] on their own line        ⇄  # … ######
 *   @[Name](Type:id) mentions                  ⇄  unchanged, exact case kept
 *   --Key::Value-- lines (own line)            ⇄  unchanged
 * Everything else (unknown tags, tags with parameters, uppercase spellings,
 * empty paragraphs, odd layouts) becomes a placeholder and is written back
 * exactly as it was. Text, including French typography, is never altered.
 *
 * Modes:
 *   paragraph: the field is a list of blocks, one per line ([p] or heading);
 *              this is also how new Markdown is written (the editor's form).
 *   plain:     anything else; newlines are kept as they are, only inline
 *              formatting is converted.
 */

export type TextMode = "paragraph" | "plain";

export interface MarkdownView {
  markdown: string;
  /** Mode to use when this Markdown is converted back. */
  mode: TextMode;
  /** True when some BBCode is shown as ⟦…⟧ placeholders. */
  hasPlaceholders: boolean;
  /** True when the whole field could only be shown raw. */
  rawFallback: boolean;
}

export const PH_OPEN = "⟦";
export const PH_CLOSE = "⟧";

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
const ESCAPABLE = new Set(["\\", "*", PH_OPEN, PH_CLOSE, "#"]);

// ---------------------------------------------------------------------------
// Placeholders

function placeholder(raw: string): string {
  return PH_OPEN + raw.replace(/[\\⟧]/g, (c) => "\\" + c) + PH_CLOSE;
}

/** Read a placeholder starting at `i` (which holds ⟦). Returns raw text and end index. */
function readPlaceholder(md: string, i: number): { raw: string; end: number } | undefined {
  let raw = "";
  for (let j = i + 1; j < md.length; j++) {
    const c = md.charAt(j);
    if (c === "\\" && j + 1 < md.length) {
      raw += md[j + 1];
      j++;
    } else if (c === PH_CLOSE) {
      return { raw, end: j + 1 };
    } else raw += c;
  }
  return undefined;
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
    text += bb[i];
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
    const next = s[i + 1];
    if (c === PH_OPEN || c === PH_CLOSE) out += "\\" + c;
    else if (c === "\\" && (next === undefined || ESCAPABLE.has(next))) out += "\\\\";
    else if (c === "*" && level === 1) out += "\\*";
    else out += c;
  }
  return out;
}

interface InlineOptions {
  /** Paragraph mode: [br] becomes a line break. Plain mode: newlines are literal. */
  mode: TextMode;
  escapeLevel: 0 | 1;
  /** Keep [br] as a placeholder (e.g. a trailing or doubled line break). */
  brPlaceholder?: boolean;
  /** Keep [b]/[i] as placeholders (last resort before raw). */
  noEmphasis?: boolean;
}

function inlineToMarkdown(bb: string, o: InlineOptions): { md: string; placeholders: boolean } {
  const tokens = tokenizeBbcode(bb);
  const matched = o.noEmphasis ? new Set<number>() : matchedEmphasis(tokens);
  let md = "";
  let placeholders = false;
  tokens.forEach((t, i) => {
    if (t.kind === "text") md += escapeText(t.value, o.escapeLevel);
    else if (t.kind === "mention") md += t.value;
    else if (matched.has(i)) md += EMPHASIS[t.value]?.md ?? t.value;
    else if (o.mode === "paragraph" && t.value === "[br]" && !o.brPlaceholder) md += "\n";
    else {
      md += placeholder(t.value);
      placeholders = true;
    }
  });
  return { md, placeholders };
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
      text += md[i + 1];
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
      if (md[i + 1] === "*") {
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
    const top = stack[stack.length - 1];
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
const H_BLOCK = /^\[h([1-6])\]([\s\S]*)\[\/h\1\]$/;
const MD_HEADING = /^(#{1,6}) ([^\n]*)$/;
/** A sidebar key-value line, displayed by World Anvil as "Key: Value". Passes through untouched. */
const SIDEBAR_LINE = /^--[^\n]*?::[^\n]*?--$/;
const isSidebarBlock = (block: string) => block.split("\n").every((l) => SIDEBAR_LINE.test(l));

/** The raw text of `md` when `md` is exactly one placeholder. */
function singlePlaceholder(md: string): string | undefined {
  if (!md.startsWith(PH_OPEN)) return undefined;
  const p = readPlaceholder(md, 0);
  return p && p.end === md.length ? p.raw : undefined;
}

/** Markdown block → BBCode line. */
function mdBlockToBbcode(block: string): string {
  const raw = singlePlaceholder(block);
  if (raw !== undefined) return raw;
  if (isSidebarBlock(block)) return block;
  const h = MD_HEADING.exec(block);
  if (h) {
    const level = (h[1] ?? "#").length;
    return `[h${level}]${inlineToBbcode(h[2] ?? "", "paragraph")}[/h${level}]`;
  }
  return `[p]${inlineToBbcode(block, "paragraph")}[/p]`;
}

/** A converted block must not blur the blank-line separators or look like something else. */
function safeBlock(md: string, line: string): boolean {
  return (
    md.length > 0 &&
    !md.includes("\n\n") &&
    !md.startsWith("\n") &&
    !md.endsWith("\n") &&
    mdBlockToBbcode(md) === line
  );
}

/** One line of a paragraph-mode field → Markdown block (placeholder when not exact). */
function blockToMarkdown(line: string): { md: string; placeholders: boolean } {
  if (SIDEBAR_LINE.test(line) && mdBlockToBbcode(line) === line)
    return { md: line, placeholders: false };
  const attempts: InlineOptions[] = [
    { mode: "paragraph", escapeLevel: 0 },
    { mode: "paragraph", escapeLevel: 1 },
    { mode: "paragraph", escapeLevel: 0, brPlaceholder: true },
    { mode: "paragraph", escapeLevel: 1, brPlaceholder: true },
    { mode: "paragraph", escapeLevel: 1, brPlaceholder: true, noEmphasis: true },
  ];
  const pInner = P_BLOCK.exec(line)?.[1];
  const h = H_BLOCK.exec(line);
  const p = pInner !== undefined && !/\[\/?p\]/.test(pInner);
  const source = p ? pInner : h?.[2];
  if (source !== undefined) {
    for (const o of attempts) {
      const inner = inlineToMarkdown(source, o);
      let md = inner.md;
      if (p && MD_HEADING.test(md)) md = "\\" + md; // a paragraph starting like a heading
      if (!p && h) md = `${"#".repeat(Number(h[1]))} ${md}`;
      if (safeBlock(md, line)) return { md, placeholders: inner.placeholders };
    }
  }
  return { md: placeholder(line), placeholders: true };
}

/** Lines of a field in the editor's layout: each line is a block starting with "[" and ending with "]". */
function paragraphLines(bb: string): string[] | undefined {
  if (!bb.includes("[p]") && !/\[h[1-6]/.test(bb)) return undefined;
  const lines = bb.split("\n");
  for (const l of lines) {
    if (SIDEBAR_LINE.test(l)) continue;
    if (!l.startsWith("[") || !l.endsWith("]")) return undefined;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API

/** Private-use character marking protected placeholders while splitting blocks. */
const SENTINEL = "\uE000";
const SENTINEL_RE = /\uE000(\d+)\uE000/g;

export function bbcodeToMarkdown(bb: string): MarkdownView {
  if (bb === "")
    return { markdown: "", mode: "paragraph", hasPlaceholders: false, rawFallback: false };

  const lines = paragraphLines(bb);
  if (lines) {
    const blocks = lines.map(blockToMarkdown);
    const markdown = blocks.map((b) => b.md).join("\n\n");
    if (markdownToBbcode(markdown, "paragraph") === bb) {
      return {
        markdown,
        mode: "paragraph",
        hasPlaceholders: blocks.some((b) => b.placeholders),
        rawFallback: false,
      };
    }
  }

  for (const o of [
    { mode: "plain", escapeLevel: 0 },
    { mode: "plain", escapeLevel: 1 },
    { mode: "plain", escapeLevel: 1, noEmphasis: true },
  ] as InlineOptions[]) {
    const r = inlineToMarkdown(bb, o);
    if (markdownToBbcode(r.md, "plain") === bb) {
      return { markdown: r.md, mode: "plain", hasPlaceholders: r.placeholders, rawFallback: false };
    }
  }

  return { markdown: placeholder(bb), mode: "plain", hasPlaceholders: true, rawFallback: true };
}

export function markdownToBbcode(md: string, mode: TextMode): string {
  // Plain mode keeps every byte, CRLF included. Paragraph mode (the editor's
  // form, which never holds CR) accepts Markdown typed with CRLF.
  if (mode === "plain") return inlineToBbcode(md, "plain");
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
    protectedText += text[i];
    i++;
  }
  const restore = (s: string) => s.replace(SENTINEL_RE, (_, n: string) => saved[Number(n)] ?? "");

  return protectedText
    .split(/\n{2,}/)
    .filter((b) => b !== "")
    .map((b) => mdBlockToBbcode(restore(b)))
    .join("\n");
}

/** Mode for writing Markdown into a field that currently holds `current`. */
export function writeModeFor(current: string | undefined): TextMode {
  if (current === undefined || current === "") return "paragraph";
  return bbcodeToMarkdown(current).mode;
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
  const sidebarLines = (bb.match(/^--[^\n]*?::[^\n]*?--$/gm) ?? []).length;
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
