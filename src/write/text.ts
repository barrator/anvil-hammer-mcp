/**
 * Text fields on the write path (stage C): Markdown → BBCode, append mode,
 * replace confirmation and the "structure that disappeared" report.
 * Pure: no network.
 */
import type { Json } from "../api/client.js";
import {
  bbcodeToMarkdown,
  markdownToBbcode,
  mentionsIn,
  missingStructure,
  writeLayoutFor,
} from "../content/bbcode.js";
import { REGISTRY } from "../registry/index.js";
import type { TypeDef } from "../registry/types.js";
import { ToolError } from "../tools/context.js";
import { isTextField, knownFields } from "./fields.js";

export type TextFormat = "markdown" | "bbcode";

export interface TextOptions {
  /** How string values of BBCode fields are given. Internal callers (restore) use "bbcode". */
  textFormat: TextFormat;
  /** Fields whose current non-empty text may be replaced as a whole. */
  replaceFields?: string[];
  /** Text to add at the end of fields, in the same format. */
  append?: Record<string, string>;
  /** Restore puts text back as it was: no replace confirmation. */
  isRestore?: boolean;
}

export interface PreparedText {
  body: Json;
  warnings: string[];
  /** field → text it held before, for appended fields (read-back checks it is intact). */
  appendedPrefixes: Record<string, string>;
}

/** Separator before appended text: a blank line in Markdown terms. */
export function appendSeparator(current: string, mode: "paragraph" | "plain"): string {
  // Paragraph fields: the editor's block separator, which a trailing newline already provides.
  if (current === "") return "";
  if (mode === "paragraph") return current.endsWith("\n") ? "" : "\n"; // the editor separates blocks by "\n"
  if (current.endsWith("\n\n")) return "";
  return current.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * Convert, check and assemble the BBCode text fields of a body.
 * `current` is the element as it is now (undefined for a create).
 */
export function prepareText(
  def: TypeDef,
  template: string | undefined,
  input: Json,
  current: Json | undefined,
  o: TextOptions,
): PreparedText {
  const known = knownFields(def, template);
  const body: Json = { ...input };
  const warnings: string[] = [];
  const needConfirmation: string[] = [];
  const unchanged: string[] = [];
  const appendedPrefixes: Record<string, string> = {};
  const currentText = (k: string) =>
    typeof current?.[k] === "string" ? (current[k] as string) : "";

  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string" || !isTextField(def, template, k)) continue;
    const cur = currentText(k);
    let bb: string;
    if (o.textFormat === "markdown") {
      // The Markdown the server showed for this text, sent back unchanged: keep the bytes.
      if (current && cur !== "" && v === bbcodeToMarkdown(cur).markdown) bb = cur;
      // The field keeps its own layout (mode and blank characters around it).
      else bb = markdownToBbcode(v, writeLayoutFor(current ? cur : undefined));
    } else bb = v;

    if (current && bb === cur) {
      unchanged.push(k);
      continue;
    }
    if (current && !o.isRestore && cur.trim() !== "") {
      if (!o.replaceFields?.includes(k)) needConfirmation.push(k);
      else {
        const lost = missingStructure(cur, bb);
        if (lost.length) warnings.push(`Replacing "${k}" removes: ${lost.join(", ")}.`);
      }
    }
    body[k] = bb;
  }

  if (needConfirmation.length) {
    throw new ToolError(
      `Refused: this would replace the whole existing text of ${needConfirmation.map((f) => `"${f}"`).join(", ")}. ` +
        "Nothing was sent. To add text at the end, use append (recommended). To really replace it, pass " +
        `replace_fields: [${needConfirmation.map((f) => `"${f}"`).join(", ")}].`,
    );
  }

  for (const [k, v] of Object.entries(o.append ?? {})) {
    if (!isTextField(def, template, k)) {
      const textFields = Object.entries(known)
        .filter(([, f]) => f.bbcode)
        .map(([n]) => n)
        .sort();
      throw new ToolError(
        `Cannot append to "${k}": it is not a text field. Text fields: ${textFields.join(", ")}.`,
      );
    }
    if (k in input)
      throw new ToolError(`"${k}" is given both as a field and in append; use one or the other.`);
    const cur = currentText(k);
    const layout = writeLayoutFor(cur);
    // Appended blocks end like the field did (e.g. the editor's trailing newline).
    const add = o.textFormat === "markdown" ? markdownToBbcode(v, { ...layout, lead: "" }) : v;
    if (add.trim() === "") throw new ToolError(`Nothing to append to "${k}".`);
    body[k] = cur + appendSeparator(cur, layout.mode) + add;
    appendedPrefixes[k] = cur;
  }

  if (unchanged.length) warnings.push(`Unchanged, not sent: ${unchanged.join(", ")}.`);
  const sent = Object.fromEntries(Object.entries(body).filter(([k]) => !unchanged.includes(k)));
  return { body: sent, warnings, appendedPrefixes };
}

/** Article templates (lowercase) that a mention type may name; all resolve as articles. */
const ARTICLE_MENTION_TYPES = new Set([
  "article",
  ...Object.keys(REGISTRY.article?.templates ?? {}),
  // Template names from the spec's article entityClass list.
  "ethnicity",
  "landmark",
  "location",
  "ritual",
  "myth",
  "technology",
  "spell",
  "law",
  "prose",
  "militaryconflict",
  "language",
  "document",
  "person",
  "organization",
  "plot",
  "species",
  "vehicle",
  "profession",
  "item",
  "formation",
  "rank",
  "condition",
  "material",
  "settlement",
  "report",
]);

/** Registered type a mention points to ("Article" and template names → article). */
export function mentionTargetType(type: string): string | undefined {
  const t = type.toLowerCase();
  if (ARTICLE_MENTION_TYPES.has(t)) return "article";
  return REGISTRY[t] ? t : undefined;
}

/** Mentions in the body's text fields that were not already in the current text. */
export function newMentions(
  def: TypeDef,
  template: string | undefined,
  body: Json,
  current: Json | undefined,
): { field: string; type: string; id: string }[] {
  const out: { field: string; type: string; id: string }[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== "string" || !isTextField(def, template, k)) continue;
    const before = new Set(
      mentionsIn(typeof current?.[k] === "string" ? (current[k] as string) : "").map(
        (m) => `${m.type}:${m.id}`,
      ),
    );
    for (const m of mentionsIn(v))
      if (!before.has(`${m.type}:${m.id}`)) out.push({ field: k, ...m });
  }
  return out;
}
