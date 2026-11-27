import type { Json } from "../api/client.js";

export const CUT_MARKER = " …[truncated]";

const size = (v: unknown) => JSON.stringify(v, null, 2).length;

export interface FitResult<T> {
  value: T;
  truncated: boolean;
  /** Fields whose text was cut. */
  cut: string[];
  /** Fields left out entirely. */
  omitted: string[];
}

/**
 * Fit one element under `max` characters (pretty-printed JSON). Fields are
 * kept in order; a long text field is cut, later fields are omitted.
 */
export function fitElement(el: Json, max: number): FitResult<Json> {
  if (size(el) <= max) return { value: el, truncated: false, cut: [], omitted: [] };

  const out: Json = {};
  const cut: string[] = [];
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(el)) {
    if (omitted.length > 0) {
      omitted.push(k);
      continue;
    }
    const candidate = { ...out, [k]: v };
    if (size(candidate) <= max) {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      const room = max - size({ ...out, [k]: "" }) - CUT_MARKER.length - 16;
      if (room > 200) {
        // JSON escaping can grow the text; shrink until it fits.
        let len = room;
        while (len > 0 && size({ ...out, [k]: v.slice(0, len) + CUT_MARKER }) > max) {
          len = Math.floor(len * 0.9);
        }
        if (len > 0) {
          out[k] = v.slice(0, len) + CUT_MARKER;
          cut.push(k);
          continue;
        }
      }
    }
    omitted.push(k);
  }
  return { value: out, truncated: true, cut, omitted };
}

export interface ListFit {
  items: Json[];
  truncated: boolean;
  /** Offset to pass to get the next items, when truncated. */
  nextOffset?: number;
}

/** Keep as many items as fit under `max`, starting at `offset`. */
export function fitList(all: Json[], offset: number, max: number): ListFit {
  const items: Json[] = [];
  let used = 2;
  for (let i = offset; i < all.length; i++) {
    const s = size(all[i]) + 4;
    if (used + s > max && items.length > 0) {
      return { items, truncated: true, nextOffset: i };
    }
    items.push(all[i] as Json);
    used += s;
  }
  return { items, truncated: false };
}
