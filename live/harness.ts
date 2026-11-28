/**
 * Live-test harness (CLAUDE.md, "Live tests"). It is the only way live tests
 * may reach World Anvil:
 * - only the single test world declared in the local, gitignored config;
 * - elements of that world discovered by listing it, or recorded in the ledger;
 * - writes only on ledger elements whose title starts with MCP-TEST-; a create
 *   must prove it targets the test world (the world itself, or a parent in the
 *   ledger or discovered in the test world).
 * Stage E adds READS only: child lists of discovered elements (a map's layers,
 * a notebook's sections…), the token owner's own profile and block templates,
 * and World Anvil's shared lists (marker types, RPG systems). Those account and
 * shared elements can never serve as a create's proof, and are never written.
 * Never weaken these rules.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORLD_ANVIL_BASE_URL } from "../src/constants.js";
import { REGISTRY } from "../src/registry/index.js";

export const TEST_PREFIX = "MCP-TEST-";
export const DEFAULT_LIVE_CONFIG = "live-test.config.json";
export const DEFAULT_LEDGER = "live-test.ledger.json";

export interface LiveConfig {
  testWorldId: string;
  ledgerFile: string;
}

export class HarnessError extends Error {
  override name = "HarnessError";
}

export function loadLiveConfig(
  path = process.env.WA_LIVE_CONFIG ?? DEFAULT_LIVE_CONFIG,
): LiveConfig {
  const p = resolve(path);
  if (!existsSync(p)) {
    throw new HarnessError(
      `Live-test config not found at ${p}. Create it (it is gitignored): {"testWorldId": "<your test world id>"}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new HarnessError(`Live-test config ${p} is not valid JSON.`);
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set(["testWorldId", "ledgerFile"]);
  for (const k of Object.keys(c))
    if (!allowed.has(k)) throw new HarnessError(`Unknown key "${k}" in ${p}.`);
  if (typeof c.testWorldId !== "string" || !c.testWorldId.trim()) {
    throw new HarnessError(`${p} must set "testWorldId" to a non-empty string.`);
  }
  const ledgerFile =
    typeof c.ledgerFile === "string" && c.ledgerFile ? c.ledgerFile : DEFAULT_LEDGER;
  return { testWorldId: c.testWorldId.trim(), ledgerFile: resolve(ledgerFile) };
}

export interface LedgerEntry {
  type: string;
  id: string;
  title: string;
  createdAt: string;
}

/** Elements created by live tests. Only these may ever be modified or deleted. */
export class Ledger {
  private entries: LedgerEntry[];

  constructor(private readonly file: string) {
    this.entries = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as LedgerEntry[])
      : [];
  }

  record(type: string, id: string, title: string): void {
    if (!title.startsWith(TEST_PREFIX)) {
      throw new HarnessError(
        `Refused: test elements must have a title starting with ${TEST_PREFIX}.`,
      );
    }
    this.entries.push({ type, id, title, createdAt: new Date().toISOString() });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + "\n");
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  /** Forget an element once it has been deleted. */
  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + "\n");
  }

  get all(): readonly LedgerEntry[] {
    return this.entries;
  }
}

const BASE_PATH = new URL(WORLD_ANVIL_BASE_URL).pathname + "/";

/** A route that does not exist, used to confirm how World Anvil answers unknown routes. */
export const UNKNOWN_ROUTE_PROBE = "mcp-test-unknown-route";

/** World-scoped list routes the tests may call with ?id=<test world>. */
const WORLD_LISTS = /^world\/[a-z_]+$/;

/** Registered list routes: path → the element type they return and the parent type of ?id=. */
const LIST_ROUTES = new Map(
  Object.values(REGISTRY)
    .filter((t) => t.list)
    .map((t) => [t.list!.path, { type: t.path, parent: t.list!.parentType }]),
);
const pathOf = (type: string) => REGISTRY[type]?.path ?? type;
/** Shared lists with no parent (catalogs). */
const SHARED_LISTS = new Set(
  [...LIST_ROUTES].filter(([, r]) => r.parent === "none").map(([p]) => p),
);
/** Numeric ids (images, markers…) repeat across types: they must match the type they were found as. */
const isNumericId = (id: string) => /^\d+$/.test(id);

export interface GuardOptions {
  testWorldId: string;
  /** In write mode the guard records created elements and forgets deleted ones. */
  ledger: Pick<Ledger, "has"> & Partial<Pick<Ledger, "record" | "remove">>;
  /** Read-only runs refuse every write outright. */
  readOnly: boolean;
}

/** Ids referenced in a request body: {id} values and [{id}] lists, at the top level. */
function referencedIds(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const take = (v: unknown) => {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as { id?: unknown }).id === "string"
    ) {
      ids.push((v as { id: string }).id);
    }
  };
  for (const [k, v] of Object.entries(body)) {
    if (k === "world") continue;
    if (Array.isArray(v)) v.forEach(take);
    else take(v);
  }
  return ids;
}

/**
 * Wrap fetch so that any request outside the test world is refused before it
 * leaves the process. Ids returned by lists of the test world become readable.
 */
export function createGuardedFetch(inner: typeof fetch, opts: GuardOptions) {
  /** Elements of the test world: id → element paths it was listed as ("*": unknown type). */
  const discovered = new Map<string, Set<string>>();
  /** The token owner's account and shared elements: readable, never a create's proof, never written. */
  const account = new Map<string, Set<string>>();
  let ownUserId: string | undefined;
  const refused: string[] = [];

  const add = (into: Map<string, Set<string>>, id: string, type: string) => {
    if (!into.has(id)) into.set(id, new Set());
    into.get(id)!.add(type);
  };
  const seenAs = (from: Map<string, Set<string>>, id: string, type: string) => {
    const types = from.get(id);
    if (!types) return false;
    return !isNumericId(id) || types.has(type) || types.has("*");
  };
  const inWorld = (id: string, type: string) => seenAs(discovered, id, type) || opts.ledger.has(id);

  const refuse = (why: string): never => {
    refused.push(why);
    throw new HarnessError(`Live-test harness refused: ${why}`);
  };

  const guarded = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.href.startsWith(WORLD_ANVIL_BASE_URL + "/"))
      refuse("request outside the World Anvil API");
    const path = url.pathname.slice(BASE_PATH.length);
    const method = (init.method ?? "GET").toUpperCase();
    const id = url.searchParams.get("id") ?? undefined;
    const isTestWorld = id === opts.testWorldId;

    /** Where ids returned by this call go, and as which type. */
    let collect: { into: Map<string, Set<string>>; type: string } | undefined;
    let pendingCreate: { type: string; title: string } | undefined;
    let isIdentity = false;
    const route = method === "POST" ? LIST_ROUTES.get(path) : undefined;

    if (method === "GET" && path === UNKNOWN_ROUTE_PROBE) {
      // No world involved.
    } else if (method === "GET" && path === "identity") {
      isIdentity = true;
    } else if (method === "POST" && path === "user/worlds") {
      // The owner's world list; tests only check whether the test world is in it.
    } else if (method === "GET" && path === "world") {
      if (!isTestWorld) refuse("reading a world other than the test world");
    } else if (method === "GET" && path === "user") {
      if (!id || id !== ownUserId) refuse("reading a user other than the token's own user");
    } else if (method === "POST" && WORLD_LISTS.test(path)) {
      if (!isTestWorld) refuse("listing a world other than the test world");
      collect = { into: discovered, type: route?.type ?? "*" };
    } else if (method === "POST" && SHARED_LISTS.has(path)) {
      if (id !== undefined) refuse("a shared list takes no parent");
      collect = { into: account, type: route!.type };
    } else if (method === "POST" && route?.parent === "user") {
      if (!id || id !== ownUserId) refuse("listing another user's elements");
      collect = { into: account, type: route.type };
    } else if (method === "POST" && route) {
      const parent = pathOf(route.parent);
      const parentScope = REGISTRY[route.parent]?.scope ?? "world";
      if (!id) refuse(`listing ${path} needs a parent`);
      if (parentScope === "world") {
        if (!inWorld(id!, parent))
          refuse("listing under an element not discovered in the test world");
        collect = { into: discovered, type: route.type };
      } else {
        if (!seenAs(account, id!, parent))
          refuse("listing under an account element not discovered");
        collect = { into: account, type: route.type };
      }
    } else if (method === "GET") {
      if (!id || !(inWorld(id, path) || seenAs(account, id, path))) {
        refuse("reading an element not discovered in the test world");
      }
    } else if (method === "PUT" || method === "PATCH" || method === "DELETE") {
      if (opts.readOnly) refuse(`${method} is not allowed in read-only live tests`);
      if (method !== "PUT" && !(id && opts.ledger.has(id)))
        refuse(`${method} on an element not in the ledger`);
      if (method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        const title = String(body.title ?? "");
        const world = (body.world as Record<string, unknown> | undefined)?.id;
        if (!title.startsWith(TEST_PREFIX))
          refuse(`created elements must be titled ${TEST_PREFIX}…`);
        if (world !== undefined && world !== opts.testWorldId)
          refuse("creating outside the test world");
        // A create must PROVE it targets the test world: the world itself, or a
        // parent (article of a secret, timeline of an event, parent category…)
        // that is in the ledger or was discovered in the test world. Account
        // and shared elements (a block's template, its RPG system) never count.
        if (world === undefined) {
          const known = referencedIds(body).some((x) => discovered.has(x) || opts.ledger.has(x));
          if (!known) refuse("a create must name the test world or a parent known to be in it");
        }
        pendingCreate = { type: path, title };
      }
    } else {
      refuse(`${method} /${path} is not an allowed live-test call`);
    }

    const res = await inner(input, init);
    if (isIdentity && res.ok) {
      try {
        const me = (await res.clone().json()) as { id?: unknown };
        if (typeof me.id === "string") ownUserId = me.id;
      } catch {
        // Not JSON: no user id.
      }
    }
    if (pendingCreate && res.ok) {
      try {
        const created = (await res.clone().json()) as { id?: unknown };
        const newId = typeof created.id === "number" ? String(created.id) : created.id;
        if (typeof newId === "string") {
          opts.ledger.record?.(pendingCreate.type, newId, pendingCreate.title);
          add(discovered, newId, pendingCreate.type);
        }
      } catch {
        // No id in the response: nothing to record.
      }
    }
    if (method === "DELETE" && res.ok && id) opts.ledger.remove?.(id);
    if (collect && res.ok) {
      try {
        const body = (await res.clone().json()) as { entities?: { id?: unknown }[] };
        for (const e of body.entities ?? []) {
          const eid = typeof e.id === "number" ? String(e.id) : e.id;
          if (typeof eid === "string") add(collect.into, eid, collect.type);
        }
      } catch {
        // Not JSON: nothing to discover.
      }
    }
    return res;
  }) as typeof fetch;

  return {
    fetch: guarded,
    /** Ids discovered in the test world so far. */
    discoveredIds: () => [...discovered.keys()],
    refused,
  };
}
