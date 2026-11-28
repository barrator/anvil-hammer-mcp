/**
 * Stage E coverage probe: READ-ONLY. For every registered type, list what the
 * test world holds (and the children of what it finds), read a few elements at
 * every granularity, and record structure only: field names, JSON kinds,
 * routes that worked. Also reads the token owner's own profile and block
 * templates and World Anvil's shared lists (field names only). Elements made
 * by hand in the test world are only read, never modified: this run cannot
 * write at all.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:coverage
 *
 * Writes live-coverage-report.json (gitignored); its "promotion" section is what
 * observed.ts may take. Prints a summary with no real data.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { loadSecrets } from "../src/config/secrets.js";
import { REGISTRY, scopeOf } from "../src/registry/index.js";
import { Ledger, createGuardedFetch, loadLiveConfig } from "./harness.js";
import { idOf, listType, readAllGranularities } from "./observe.js";
import { LiveReport } from "./report.js";

const REPORT_FILE = process.env.WA_LIVE_COVERAGE_REPORT ?? "live-coverage-report.json";
/** Elements read per type (each at every granularity: about 3 s per element). */
const SAMPLES = 3;
/** Parents whose children are listed, per parent type. */
const PARENTS = 2;

const report = new LiveReport();
let client: WorldAnvilClient;
let guard: ReturnType<typeof createGuardedFetch>;
let testWorldId: string;
/** type → ids read, so children can be listed under them. */
const found = new Map<string, string[]>();
/** type → every id listed (for the era and lane shapes, read at granularity 2). */
const listedIds = new Map<string, string[]>();
const MAX_SHAPES = 20;

beforeAll(() => {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
  const live = loadLiveConfig();
  testWorldId = live.testWorldId;
  report.hide(testWorldId);
  guard = createGuardedFetch(fetch, {
    testWorldId,
    ledger: new Ledger(live.ledgerFile),
    readOnly: true,
  });
  client = new WorldAnvilClient(loadSecrets(process.env), { fetch: guard.fetch });
});

afterAll(() => {
  if (!guard) return;
  report.check(
    "harness refused no call",
    guard.refused.length === 0,
    guard.refused.join("; ") || undefined,
  );
  report.write(REPORT_FILE);
  const routes = Object.entries(report.types)
    .map(
      ([t, o]) =>
        `${t}: ${Object.entries(o.routes ?? {})
          .map(([v, r]) => `${v} ${r}`)
          .join(", ")}`,
    )
    .join("\n");
  console.log(`\n${report.summary()}\n\nRoutes:\n${routes}\n\nFull report: ${REPORT_FILE}`);
  report.assertAllPassed();
});

async function sample(type: string, items: Json[]) {
  const ids = items.map(idOf).filter((x): x is string => x !== undefined);
  for (const id of ids.slice(0, SAMPLES)) {
    report.hide(id);
    await readAllGranularities(report, client, type, id);
  }
  found.set(type, [...(found.get(type) ?? []), ...ids.slice(0, PARENTS)]);
  listedIds.set(type, [...(listedIds.get(type) ?? []), ...ids]);
  report.hide(...ids);
}

describe("coverage probe: world elements", () => {
  it("lists every world type in the test world, then the children of what it found", async () => {
    const worldTypes = Object.values(REGISTRY).filter(
      (t) => t.list && scopeOf(t) === "world" && t.name !== "world",
    );
    // Top-level lists first, then children in registry order until nothing new is found.
    const pending = new Set(worldTypes.map((t) => t.name));
    for (let round = 0; round < 5 && pending.size; round++) {
      for (const name of [...pending]) {
        const t = REGISTRY[name]!;
        const parentType = t.list!.parentType;
        if (parentType === "world") {
          await sample(name, await listType(report, client, name, testWorldId));
          pending.delete(name);
        } else if (found.has(parentType)) {
          for (const pid of found.get(parentType)!)
            await sample(name, await listType(report, client, name, pid));
          pending.delete(name);
        }
      }
    }
    report.quirks.typesWithNothingToList = [...pending];
  });

  it("records the shape of eras and lanes without any id or title", async () => {
    const shapes: Json = { timelinesWithEras: 0, eraKeys: [], lanes: [] };
    for (const id of (listedIds.get("timeline") ?? []).slice(0, MAX_SHAPES)) {
      const t = await client.request<Json>("GET", "timeline", { id, granularity: "2" });
      const eras = Array.isArray(t.eras) ? (t.eras as Json[]) : [];
      if (eras.length) shapes.timelinesWithEras = (shapes.timelinesWithEras as number) + 1;
      shapes.eraKeys = [
        ...new Set([...(shapes.eraKeys as string[]), ...eras.flatMap((e) => Object.keys(e))]),
      ].sort();
    }
    for (const id of (listedIds.get("history") ?? []).slice(0, MAX_SHAPES)) {
      const h = await client.request<Json>("GET", "history", { id, granularity: "2" });
      const lane = h.lane;
      let parsed: unknown;
      try {
        parsed = typeof lane === "string" && lane ? JSON.parse(lane) : undefined;
      } catch {
        parsed = "unparsable";
      }
      const timelines = Array.isArray(h.timelines) ? (h.timelines as Json[]).map(idOf) : [];
      (shapes.lanes as Json[]).push({
        laneKind: lane === null ? "null" : typeof lane,
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0,
        keysAreItsTimelines:
          parsed && typeof parsed === "object"
            ? Object.keys(parsed).every((k) => timelines.includes(k))
            : undefined,
        valueKinds:
          parsed && typeof parsed === "object"
            ? [...new Set(Object.values(parsed).map((v) => typeof v))]
            : [],
        timelines: timelines.length,
        endWithoutEndingYear:
          h.endingMonth !== null &&
          h.endingMonth !== undefined &&
          h.endingMonth !== "" &&
          (h.endingYear === null || h.endingYear === undefined || h.endingYear === ""),
      });
    }
    report.quirks.erasAndLanes = shapes;
  });
});

describe("coverage probe: your account and shared lists (field names only)", () => {
  it("reads your profile, your block templates and the shared lists", async () => {
    const me = await client.request<Json>("GET", "identity");
    const ownId = idOf(me);
    if (ownId) {
      report.hide(ownId);
      await readAllGranularities(report, client, "user", ownId);
      await sample("blocktemplate", await listType(report, client, "blocktemplate", ownId));
      for (const pid of found.get("blocktemplate") ?? [])
        await sample("blocktemplatepart", await listType(report, client, "blocktemplatepart", pid));
    }
    await sample("markertype", await listType(report, client, "markertype", undefined));
    await sample("rpgsystem", await listType(report, client, "rpgsystem", undefined));
  });
});
