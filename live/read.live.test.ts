/**
 * Stage A live run: read-only, test world only, through the harness.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live
 *
 * Writes live-test-report.json (gitignored) and prints a summary with no real data.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { AccessPolicy } from "../src/config/access.js";
import type { Config } from "../src/config/index.js";
import { loadSecrets, type Secrets } from "../src/config/secrets.js";
import { DEFAULT_MAX_RESPONSE_CHARS } from "../src/constants.js";
import { REGISTRY } from "../src/registry/index.js";
import { createServer } from "../src/server.js";
import { Ledger, UNKNOWN_ROUTE_PROBE, createGuardedFetch, loadLiveConfig } from "./harness.js";
import { LiveReport } from "./report.js";

const REPORT_FILE = process.env.WA_LIVE_REPORT ?? "live-test-report.json";
const SAMPLES_PER_TYPE = 2;
const TYPES = ["article", "category", "secret", "subscribergroup", "timeline", "history"] as const;

const report = new LiveReport();
let secrets: Secrets;
let testWorldId: string;
let guard: ReturnType<typeof createGuardedFetch>;
let client: WorldAnvilClient;
const sampleIds: Record<string, string[]> = {};

function requireKeyFiles() {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
}

async function mcp(access: AccessPolicy) {
  const config: Config = { secrets, access, maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS };
  const server = createServer(config, { clientOptions: { fetch: guard.fetch } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "live-test", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((x) => x.text).join("\n");
    return { isError: r.isError === true, text };
  };
}

const leaksSecret = (text: string) =>
  [secrets.appKey, secrets.authToken].some(
    (s) => text.includes(s) || text.includes(encodeURIComponent(s)),
  );

beforeAll(() => {
  requireKeyFiles();
  secrets = loadSecrets(process.env);
  const live = loadLiveConfig();
  testWorldId = live.testWorldId;
  guard = createGuardedFetch(fetch, {
    testWorldId,
    ledger: new Ledger(live.ledgerFile),
    readOnly: true,
  });
  client = new WorldAnvilClient(secrets, { fetch: guard.fetch });
});

afterAll(() => {
  if (!guard) return; // setup failed: the error above says why
  report.check(
    "harness refused no call",
    guard.refused.length === 0,
    guard.refused.join("; ") || undefined,
  );
  report.write(REPORT_FILE);
  console.log(`\n${report.summary()}\n\nFull report: ${REPORT_FILE}`);
});

describe("live read: raw API observations", () => {
  it("lists every stage A type in the test world and samples elements", async () => {
    for (const type of TYPES) {
      const def = REGISTRY[type]!;
      const obs = report.type(type);
      const { items } = await client.listAll(def.list!.path, testWorldId);
      obs.listed = items.length;
      obs.listFields = [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
      sampleIds[type] = items
        .map((i) => i.id)
        .filter((id): id is string => typeof id === "string")
        .slice(0, SAMPLES_PER_TYPE);
      report.check(`list ${type}`, true);
    }
  });

  it("reads each sample at every granularity and records fields and links", async () => {
    const world = report.type("world");
    world.sampled = 1;
    for (const g of REGISTRY.world!.granularities) {
      const el = await client.request<Json>("GET", "world", { id: testWorldId, granularity: g });
      world.granularities[g] = {
        fields: Object.keys(el).sort(),
        withWorldField: 0,
        withParentLink: {},
        of: 1,
      };
    }
    for (const type of TYPES) {
      const def = REGISTRY[type]!;
      const obs = report.type(type);
      const ids = sampleIds[type] ?? [];
      obs.sampled = ids.length;
      for (const g of def.granularities) {
        const fields = new Set<string>();
        const entry = {
          fields: [] as string[],
          withWorldField: 0,
          withParentLink: {} as Record<string, number>,
          of: ids.length,
        };
        for (const p of def.parents) entry.withParentLink[p.field] = 0;
        for (const id of ids) {
          const el = await client.request<Json>("GET", def.path, { id, granularity: g });
          Object.keys(el).forEach((k) => fields.add(k));
          if ((el.world as Json | undefined)?.id) entry.withWorldField++;
          for (const p of def.parents) {
            const v = el[p.field];
            if ((Array.isArray(v) ? v[0] : v) && typeof (Array.isArray(v) ? v[0] : v) === "object")
              entry.withParentLink[p.field]!++;
          }
          if (type === "article" && typeof el.templateType === "string") {
            obs.templateTypes ??= {};
            obs.templateTypes[el.templateType] = (obs.templateTypes[el.templateType] ?? 0) + 1;
          }
        }
        entry.fields = [...fields].sort();
        obs.granularities[g] = entry;
      }
    }
    report.check("granularity reads", true);
  });

  it("records how World Anvil answers an unknown route", async () => {
    const res = await guard.fetch(
      `https://www.worldanvil.com/api/external/boromir/${UNKNOWN_ROUTE_PROBE}`,
      {
        headers: {
          "x-application-key": secrets.appKey,
          "x-auth-token": secrets.authToken,
          "Content-Type": "application/json",
        },
      },
    );
    const text = await res.text();
    report.quirks.unknownRoute = {
      status: res.status,
      contentType: res.headers.get("content-type")?.split(";")[0],
      bodyLooksHtml: /^\s*</.test(text),
    };
    const err = await client
      .request("GET", UNKNOWN_ROUTE_PROBE)
      .catch((e: Error & { kind?: string }) => e);
    report.check(
      "client turns unknown route into a clean error",
      err instanceof Error && !/<html/i.test(err.message),
      (err as { kind?: string }).kind,
    );
  });
});

describe("live read: MCP tools through the harness", () => {
  it("read_only test world: every read tool works and marks content", async () => {
    const call = await mcp(new AccessPolicy(new Map([[testWorldId, "read_only"]])));
    const outputs: string[] = [];

    const worlds = await call("wa_list_worlds");
    outputs.push(worlds.text);
    report.check(
      "wa_list_worlds lists the test world",
      !worlds.isError && worlds.text.includes(testWorldId),
    );

    const w = await call("wa_get", { type: "world", id: testWorldId });
    outputs.push(w.text);
    report.check("wa_get world", !w.isError);

    const arts = await call("wa_list_articles", { world_id: testWorldId });
    outputs.push(arts.text);
    report.check("wa_list_articles", !arts.isError);

    for (const type of TYPES) {
      const l = await call("wa_list", { type, parent_id: testWorldId });
      outputs.push(l.text);
      report.check(`wa_list ${type}`, !l.isError);
      for (const id of sampleIds[type] ?? []) {
        for (const g of ["-1", REGISTRY[type]!.defaultGranularity]) {
          const r = await call("wa_get", { type, id, granularity: g });
          outputs.push(r.text);
          report.check(
            `wa_get ${type} at granularity ${g} resolves its world`,
            !r.isError,
            r.isError ? r.text.slice(0, 120).replace(id, "<id>") : undefined,
          );
        }
      }
    }

    report.check(
      "every content result is wrapped as untrusted",
      outputs
        .filter((t) => !t.startsWith("[anvil-hammer-mcp] Not found"))
        .every((t) => t.includes("<untrusted_world_content")),
    );
    report.check(
      "no key in any tool output",
      outputs.every((t) => !leaksSecret(t)),
    );
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  });

  it("blocked test world: invisible everywhere, including children", async () => {
    const call = await mcp(new AccessPolicy(new Map([[testWorldId, "blocked"]])));
    const worlds = await call("wa_list_worlds");
    report.check(
      "blocked: wa_list_worlds hides the test world",
      !worlds.text.includes(testWorldId),
    );
    const w = await call("wa_get", { type: "world", id: testWorldId });
    report.check("blocked: wa_get world is not found", w.isError && /Not found/.test(w.text));
    const l = await call("wa_list_articles", { world_id: testWorldId });
    report.check("blocked: wa_list_articles is not found", l.isError && /Not found/.test(l.text));
    for (const type of TYPES) {
      const id = sampleIds[type]?.[0];
      if (!id) continue;
      const r = await call("wa_get", { type, id });
      report.check(
        `blocked: wa_get ${type} by ID is not found`,
        r.isError && /Not found/.test(r.text) && !r.text.includes("<untrusted_world_content"),
      );
    }
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  });
});
