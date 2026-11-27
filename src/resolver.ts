import type { Json, WorldAnvilClient } from "./api/client.js";
import { getType } from "./registry/index.js";
import type { SessionState } from "./session.js";

/** Id of a reference field: {id} object, or the first {id} of a list. */
export function refId(value: unknown): string | undefined {
  if (Array.isArray(value)) return refId(value[0]);
  if (value && typeof value === "object") {
    const id = (value as Json).id;
    if (typeof id === "string" && id) return id;
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

const MAX_DEPTH = 4;

/**
 * Find the world an element belongs to: first the element's own world
 * reference, then its parent chain (e.g. history → timeline → world). Fetches
 * the element again at a higher granularity when the link fields are missing.
 * Returns undefined when no chain can be found; callers must then refuse.
 */
export class WorldResolver {
  constructor(private readonly client: WorldAnvilClient) {}

  async resolve(
    state: SessionState,
    type: string,
    id: string,
    known?: { element: Json; granularity: string },
  ): Promise<string | undefined> {
    return this.walk(state, type, id, known, 0, new Set());
  }

  private async walk(
    state: SessionState,
    type: string,
    id: string,
    known: { element: Json; granularity: string } | undefined,
    depth: number,
    visited: Set<string>,
  ): Promise<string | undefined> {
    if (type === "world") return id;
    const key = `${type}:${id}`;
    const cached = state.worlds.get(key);
    if (cached) return cached;
    if (depth > MAX_DEPTH || visited.has(key)) return undefined;
    visited.add(key);

    const def = getType(type);
    const found = async (el: Json): Promise<string | undefined> => {
      if (def.world) {
        const w = refId(el[def.world.field]);
        if (w) return w;
      }
      for (const p of def.parents) {
        const pid = refId(el[p.field]);
        if (!pid) continue;
        const w = await this.walk(state, p.type, pid, undefined, depth + 1, visited);
        if (w) return w;
      }
      return undefined;
    };

    let world = known ? await found(known.element) : undefined;

    if (!world) {
      // Fetch at the granularity where the link fields are expected.
      const needed = [def.world?.granularity, ...def.parents.map((p) => p.granularity)]
        .filter((g): g is string => g !== undefined)
        .map(Number);
      const target = String(Math.max(...needed, Number(def.defaultGranularity)));
      const allowed = def.granularities.map(Number);
      const g = String(Math.min(Number(target), Math.max(...allowed)));
      if (!known || Number(known.granularity) < Number(g)) {
        try {
          const el = await this.client.request<Json>("GET", def.path, { id, granularity: g });
          world = await found(el);
        } catch {
          world = undefined;
        }
      }
    }

    if (world) state.worlds.set(key, world);
    return world;
  }
}
