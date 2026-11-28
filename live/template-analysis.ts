/**
 * Pure analysis for the template probe: which fields each article template
 * returns at granularity 2, beyond the generic article fields. Produces
 * structure only (field names, JSON kinds, counts), never values.
 */
import { RESPONSE_FLAGS } from "../src/output/compact.js";

export type JsonKind = "string" | "number" | "boolean" | "null" | "array" | "ref" | "object";

export function kindOf(v: unknown): JsonKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object")
    return typeof (v as Record<string, unknown>).id === "string" ? "ref" : "object";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

export interface TemplateFields {
  /** Articles of this template that were read. */
  articles: number;
  /** Fields specific to this template: field → JSON kinds seen and how many articles had a non-empty value. */
  specific: Record<string, { kinds: JsonKind[]; nonEmpty: number }>;
}

export interface TemplateAnalysis {
  /** How generic fields were determined. */
  genericBasis: "plain-article-template" | "common-to-all-templates";
  /** Fields treated as generic article fields (present for every template, or on plain articles). */
  generic: string[];
  templates: Record<string, TemplateFields>;
}

const isEmptyValue = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * @param articles  article bodies read at granularity 2
 * @param registryArticleFields  generic fields already in the registry
 */
export function analyzeTemplates(
  articles: Record<string, unknown>[],
  registryArticleFields: readonly string[],
): TemplateAnalysis {
  const byTemplate = new Map<string, Record<string, unknown>[]>();
  for (const a of articles) {
    const t =
      typeof a.templateType === "string" && a.templateType
        ? a.templateType.toLowerCase()
        : "unknown";
    if (!byTemplate.has(t)) byTemplate.set(t, []);
    byTemplate.get(t)!.push(a);
  }

  const keysOf = (list: Record<string, unknown>[]) =>
    new Set(list.flatMap((a) => Object.keys(a)).filter((k) => !RESPONSE_FLAGS.has(k)));

  let generic: Set<string>;
  let basis: TemplateAnalysis["genericBasis"];
  const plain = byTemplate.get("article");
  if (plain && plain.length > 0) {
    generic = keysOf(plain);
    basis = "plain-article-template";
  } else {
    const sets = [...byTemplate.values()].map(keysOf);
    generic = sets.length
      ? new Set([...sets[0]!].filter((k) => sets.every((s) => s.has(k))))
      : new Set();
    basis = "common-to-all-templates";
  }
  for (const f of registryArticleFields) generic.add(f);

  const templates: Record<string, TemplateFields> = {};
  for (const [t, list] of byTemplate) {
    if (t === "article") continue;
    const specific: TemplateFields["specific"] = {};
    for (const a of list) {
      for (const [k, v] of Object.entries(a)) {
        if (generic.has(k) || RESPONSE_FLAGS.has(k)) continue;
        const s = (specific[k] ??= { kinds: [], nonEmpty: 0 });
        const kind = kindOf(v);
        if (!s.kinds.includes(kind)) s.kinds.push(kind);
        if (!isEmptyValue(v)) s.nonEmpty++;
      }
    }
    for (const s of Object.values(specific)) s.kinds.sort();
    templates[t] = {
      articles: list.length,
      specific: Object.fromEntries(Object.entries(specific).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
  return { genericBasis: basis, generic: [...generic].sort(), templates };
}
