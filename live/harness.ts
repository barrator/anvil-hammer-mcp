/**
 * Live-test harness (CLAUDE.md, "Live tests"). It is the only way live tests
 * may reach World Anvil:
 * - only the single test world declared in the local, gitignored config;
 * - elements of that world discovered by listing it, or recorded in the ledger;
 * - writes only on ledger elements whose title starts with MCP-TEST-
 *   (and, in this stage, no writes at all).
 * Never weaken these rules.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORLD_ANVIL_BASE_URL } from "../src/constants.js";

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

  get all(): readonly LedgerEntry[] {
    return this.entries;
  }
}

const BASE_PATH = new URL(WORLD_ANVIL_BASE_URL).pathname + "/";

/** A route that does not exist, used to confirm how World Anvil answers unknown routes. */
export const UNKNOWN_ROUTE_PROBE = "mcp-test-unknown-route";

/** World-scoped list routes the tests may call with ?id=<test world>. */
const WORLD_LISTS = /^world\/[a-z_]+$/;

export interface GuardOptions {
  testWorldId: string;
  ledger: Pick<Ledger, "has">;
  /** Stage A: true. Writes are refused outright. */
  readOnly: boolean;
}

/**
 * Wrap fetch so that any request outside the test world is refused before it
 * leaves the process. Ids returned by lists of the test world become readable.
 */
export function createGuardedFetch(inner: typeof fetch, opts: GuardOptions) {
  const discovered = new Set<string>();
  const refused: string[] = [];

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

    let collectIds = false;
    if (method === "GET" && (path === "identity" || path === UNKNOWN_ROUTE_PROBE)) {
      // No world involved.
    } else if (method === "POST" && path === "user/worlds") {
      // The owner's world list; tests only check whether the test world is in it.
    } else if (method === "GET" && path === "world") {
      if (!isTestWorld) refuse("reading a world other than the test world");
    } else if (method === "POST" && WORLD_LISTS.test(path)) {
      if (!isTestWorld) refuse("listing a world other than the test world");
      collectIds = true;
    } else if (method === "GET") {
      if (!id || !(discovered.has(id) || opts.ledger.has(id))) {
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
      }
    } else {
      refuse(`${method} /${path} is not an allowed live-test call`);
    }

    const res = await inner(input, init);
    if (collectIds && res.ok) {
      const copy = res.clone();
      try {
        const body = (await copy.json()) as { entities?: { id?: unknown }[] };
        for (const e of body.entities ?? []) if (typeof e.id === "string") discovered.add(e.id);
      } catch {
        // Not JSON: nothing to discover.
      }
    }
    return res;
  }) as typeof fetch;

  return { fetch: guarded, discovered, refused };
}
