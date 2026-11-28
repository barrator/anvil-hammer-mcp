/**
 * Shared helpers for the stage E live tests: record the structure of real
 * responses (field names, JSON kinds, routes) without any value.
 */
import { type Json, WorldAnvilApiError, type WorldAnvilClient } from "../src/api/client.js";
import { REGISTRY } from "../src/registry/index.js";
import type { LiveReport } from "./report.js";
import { kindOf } from "./template-analysis.js";

const BBCODE_LIKE =
  /\[(?:p|b|i|s|u|h[1-6]|br|ul|ol|li|url|img|quote|center|table)(?:[\]:|=]|\s*\/\])/;

/** Error kind of a failed call, for the report ("not_found" for the HTML 404 page). */
export function errorKind(err: unknown): string {
  return err instanceof WorldAnvilApiError ? err.kind : "unexpected";
}

/** Record one element's fields and kinds under its type, at a granularity. */
export function observeElement(report: LiveReport, type: string, granularity: string, el: Json) {
  const def = REGISTRY[type];
  const obs = report.type(type);
  const entry = (obs.granularities[granularity] ??= {
    fields: [],
    withWorldField: 0,
    withParentLink: {},
    of: 0,
  });
  entry.of++;
  entry.fields = [...new Set([...entry.fields, ...Object.keys(el)])].sort();
  if (el.world && typeof el.world === "object") entry.withWorldField++;
  for (const p of def?.parents ?? []) {
    const v = el[p.field];
    const first = Array.isArray(v) ? v[0] : v;
    entry.withParentLink[p.field] =
      (entry.withParentLink[p.field] ?? 0) + (first && typeof first === "object" ? 1 : 0);
  }
  obs.kinds ??= {};
  for (const [k, v] of Object.entries(el)) {
    const kind = kindOf(v);
    if (kind === "null" || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const list = (obs.kinds[k] ??= []);
    if (!list.includes(kind)) list.push(kind);
  }
  for (const [k, f] of Object.entries(def?.fields ?? {})) {
    if (!f.bbcode || typeof el[k] !== "string" || el[k] === "") continue;
    obs.bbcode ??= {};
    const b = (obs.bbcode[k] ??= { withTags: 0, plain: 0 });
    if (BBCODE_LIKE.test(el[k] as string)) b.withTags++;
    else b.plain++;
  }
}

export function routeResult(report: LiveReport, type: string, verb: string, result: string) {
  const obs = report.type(type);
  obs.routes ??= {};
  // Keep the first failure if a later call of the same verb works, so nothing is hidden.
  if (obs.routes[verb] && obs.routes[verb] !== "ok") return;
  obs.routes[verb] = result;
}

/** Read an element at every granularity of its type; records fields, kinds and the get route. */
export async function readAllGranularities(
  report: LiveReport,
  client: WorldAnvilClient,
  type: string,
  id: string,
): Promise<Json | undefined> {
  const def = REGISTRY[type]!;
  let last: Json | undefined;
  report.type(type).sampled++;
  for (const g of def.granularities) {
    try {
      const el = await client.request<Json>("GET", def.path, { id, granularity: g });
      observeElement(report, type, g, el);
      routeResult(report, type, "get", "ok");
      last = el;
    } catch (err) {
      routeResult(report, type, "get", errorKind(err));
    }
  }
  return last;
}

/** List a type under a parent; records the list route and the list item fields. */
export async function listType(
  report: LiveReport,
  client: WorldAnvilClient,
  type: string,
  parentId: string | undefined,
): Promise<Json[]> {
  const def = REGISTRY[type]!;
  try {
    const { items } = await client.listAll(def.list!.path, parentId);
    const obs = report.type(type);
    obs.listed += items.length;
    obs.listFields = [
      ...new Set([...obs.listFields, ...items.flatMap((i) => Object.keys(i))]),
    ].sort();
    routeResult(report, type, "list", "ok");
    return items;
  } catch (err) {
    routeResult(report, type, "list", errorKind(err));
    return [];
  }
}

export const idOf = (el: Json): string | undefined =>
  typeof el.id === "string" ? el.id : typeof el.id === "number" ? String(el.id) : undefined;
