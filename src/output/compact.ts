import type { Json } from "../api/client.js";

/** Response flags World Anvil adds to element bodies; not element fields. */
export const RESPONSE_FLAGS = new Set(["success"]);

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** A nested object that is a reference to another element. */
function isLinkedElement(v: Json): boolean {
  return (
    typeof v.id === "string" && (typeof v.title === "string" || typeof v.entityClass === "string")
  );
}

/** Reduce a linked element to {id, title, type}. */
export function reduceLink(v: Json): Json {
  const out: Json = { id: v.id };
  if (typeof v.title === "string" && v.title) out.title = v.title;
  if (typeof v.entityClass === "string" && v.entityClass) out.type = v.entityClass;
  return out;
}

function compactInner(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) {
    return v.map((x) => compactInner(x, depth + 1)).filter((x) => !isEmpty(x));
  }
  if (v && typeof v === "object") {
    const o = v as Json;
    if (depth > 0 && isLinkedElement(o)) return reduceLink(o);
    const out: Json = {};
    for (const [k, val] of Object.entries(o)) {
      if (depth === 0 && RESPONSE_FLAGS.has(k)) continue;
      const c = compactInner(val, depth + 1);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  return v;
}

/**
 * Compact an element: drop response flags (`success`) and empty fields, reduce linked elements to
 * {id, title, type}. The top-level element itself is kept whole.
 */
export function compactElement(el: Json): Json {
  return compactInner(el, 0) as Json;
}

/** Keep only the requested top-level fields (id is always kept). */
export function pickFields(el: Json, fields: readonly string[] | undefined): Json {
  if (!fields || fields.length === 0) return el;
  const out: Json = {};
  for (const k of ["id", ...fields]) if (k in el) out[k] = el[k];
  return out;
}

/** Fields requested but absent from the element (to tell the user). */
export function missingFields(el: Json, fields: readonly string[] | undefined): string[] {
  return (fields ?? []).filter((f) => !(f in el));
}
