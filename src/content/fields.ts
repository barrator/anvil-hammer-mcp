/** Apply the BBCode → Markdown view to the text fields of an element (read path). */
import type { Json } from "../api/client.js";
import { getType } from "../registry/index.js";
import { isTextField } from "../write/fields.js";
import { bbcodeToMarkdown } from "./bbcode.js";

export interface ElementView {
  element: Json;
  /** Text fields shown as Markdown. */
  converted: string[];
  placeholders: boolean;
  /** Fields that could only be shown raw, as one placeholder. */
  rawFallback: string[];
}

export function elementToMarkdown(type: string, element: Json): ElementView {
  const def = getType(type);
  const template = typeof element.templateType === "string" ? element.templateType : undefined;
  const out: Json = { ...element };
  const view: ElementView = { element: out, converted: [], placeholders: false, rawFallback: [] };
  for (const [k, v] of Object.entries(element)) {
    if (typeof v !== "string" || v === "" || !isTextField(def, template, k)) continue;
    const md = bbcodeToMarkdown(v);
    out[k] = md.markdown;
    view.converted.push(k);
    if (md.hasPlaceholders) view.placeholders = true;
    if (md.rawFallback) view.rawFallback.push(k);
  }
  return view;
}

/** Server notes explaining the Markdown view. */
export function markdownNotes(views: ElementView[]): string[] {
  if (!views.some((v) => v.converted.length)) return [];
  const notes = [
    'Text fields are shown as Markdown (use format: "bbcode" for raw BBCode). Write Markdown back the same way.',
  ];
  if (views.some((v) => v.placeholders)) {
    notes.push(
      "⟦…⟧ marks BBCode kept exactly as is: leave it unchanged when you write the text back.",
    );
  }
  const raw = [...new Set(views.flatMap((v) => v.rawFallback))];
  if (raw.length)
    notes.push(`Shown whole as one ⟦…⟧ block (could not be converted safely): ${raw.join(", ")}.`);
  return notes;
}
