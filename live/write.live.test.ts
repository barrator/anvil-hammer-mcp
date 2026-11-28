/**
 * Stage B live run: safe writes in the test world only, through the harness.
 * Creates MCP-TEST- elements (recorded in the ledger), updates, provokes a
 * conflict from a second session, restores, then deletes everything it made.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:write
 *
 * If it stops halfway: npm run test:live:cleanup deletes everything in the ledger.
 * Writes live-write-report.json (gitignored) and prints a summary with no real data.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { Ledger, TEST_PREFIX, createGuardedFetch, loadLiveConfig } from "./harness.js";
import { LiveReport } from "./report.js";

const REPORT_FILE = process.env.WA_LIVE_WRITE_REPORT ?? "live-write-report.json";
const report = new LiveReport();

let secrets: Secrets;
let testWorldId: string;
let ledger: Ledger;
let guard: ReturnType<typeof createGuardedFetch>;
let raw: WorldAnvilClient;
let backupDir: string;
type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;
let alice: Call;
let bob: Call;
/** Created elements, in creation order: deleted in reverse at the end. */
const created: { type: string; id: string }[] = [];
const tag = `${TEST_PREFIX}${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}-`;

async function server(
  enableDelete: boolean,
): Promise<{ call: Call; tools: () => Promise<string[]> }> {
  const config: Config = {
    secrets,
    access: new AccessPolicy(new Map([[testWorldId, "full_edit"]])),
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    backupDir,
    backupRetentionDays: 1,
    enableDelete,
  };
  const s = createServer(config, { clientOptions: { fetch: guard.fetch } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "live-write", version: "0" });
  await Promise.all([s.connect(a), c.connect(b)]);
  return {
    call: async (name, args = {}) => {
      const r = await c.callTool({ name, arguments: args });
      return {
        isError: r.isError === true,
        text: (r.content as { text: string }[]).map((x) => x.text).join("\n"),
      };
    },
    tools: async () => (await c.listTools()).tools.map((t) => t.name),
  };
}

/** Id of the element a write result reports, from its untrusted block. */
function createdId(text: string): string {
  const m = /<untrusted_world_content source="[a-z]+:([^"]+)">/.exec(text);
  if (!m || m[1] === "new") throw new Error("no id in result");
  return m[1]!;
}

const line = (text: string, re: RegExp) =>
  re
    .exec(text)?.[1]
    ?.split(", ")
    .map((s) => s.replace(/\.$/, "")) ?? [];
const ignoredIn = (text: string) => line(text, /did NOT store: ([^\n]+)/);
const storedIn = (text: string) => line(text, /Stored: ([^\n]+)/);

async function rawGet(type: string, id: string, granularity: string): Promise<Json> {
  return raw.request<Json>("GET", REGISTRY[type]!.path, { id, granularity });
}

/** Correction C: every created element must come back private (and draft where the type has it). */
async function checkPrivateDraft(type: string, id: string) {
  const def = REGISTRY[type]!;
  const el = await rawGet(type, id, def.backupGranularity);
  if (el.updateDate === undefined || el.updateDate === null) {
    const list = (report.quirks.typesWithoutUpdateDate ??= []) as string[];
    if (!list.includes(type)) list.push(type);
  }
  const hasState = "state" in def.fields;
  const hasDraft = "isDraft" in def.fields;
  if (!hasState && !hasDraft) {
    report.check(`${type}: has no visibility fields (state/isDraft), nothing to check`, true);
    return;
  }
  const privateOk = !hasState || el.state === "private";
  const draftOk = !hasDraft || el.isDraft === true || el.isDraft === 1;
  const what = [hasState && "private", hasDraft && "draft"].filter(Boolean).join(" and ");
  report.check(
    `${type}: created ${what}`,
    privateOk && draftOk,
    privateOk && draftOk ? undefined : `state ${String(el.state)}, isDraft ${String(el.isDraft)}`,
  );
}

/** Record field names at every granularity for the report (structure only). */
async function observe(type: string, id: string) {
  const def = REGISTRY[type]!;
  const obs = report.type(type);
  obs.sampled++;
  for (const g of def.granularities) {
    const el = await rawGet(type, id, g);
    const entry = (obs.granularities[g] ??= {
      fields: [],
      withWorldField: 0,
      withParentLink: {},
      of: 0,
    });
    entry.of++;
    entry.fields = [...new Set([...entry.fields, ...Object.keys(el)])].sort();
    if ((el.world as Json | undefined)?.id) entry.withWorldField++;
    for (const p of def.parents) {
      const v = el[p.field];
      const first = Array.isArray(v) ? v[0] : v;
      entry.withParentLink[p.field] =
        (entry.withParentLink[p.field] ?? 0) + (first && typeof first === "object" ? 1 : 0);
    }
  }
}

async function create(type: string, tool: string, args: Record<string, unknown>) {
  const r = await alice(tool, args);
  report.check(
    `create ${type} (${tool})`,
    !r.isError,
    r.isError ? r.text.slice(0, 160) : undefined,
  );
  expect(r.isError, r.text).toBe(false);
  const id = createdId(r.text);
  report.hide(id);
  created.push({ type, id });
  await checkPrivateDraft(type, id);
  return { id, text: r.text };
}

beforeAll(async () => {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
  secrets = loadSecrets(process.env);
  const live = loadLiveConfig();
  testWorldId = live.testWorldId;
  report.hide(testWorldId);
  ledger = new Ledger(live.ledgerFile);
  guard = createGuardedFetch(fetch, { testWorldId, ledger, readOnly: false });
  raw = new WorldAnvilClient(secrets, { fetch: guard.fetch });
  backupDir = mkdtempSync(join(tmpdir(), "ahm-live-write-"));
  alice = (await server(true)).call;
  bob = (await server(true)).call;
});

afterAll(async () => {
  if (!guard) return; // setup failed: the error above says why
  // Delete everything this run created, children first, through the server (backup first).
  report.hide(testWorldId, ...created.map((c) => c.id));
  let deleted = 0;
  for (const el of [...created].reverse()) {
    await alice("wa_get", { type: el.type, id: el.id }).catch(() => undefined);
    const r = await alice("wa_delete", { type: el.type, id: el.id }).catch((e: Error) => ({
      isError: true,
      text: e.message,
    }));
    const ok = !r.isError && /-delete\.json/.test(r.text);
    if (ok) deleted++;
    else report.check(`cleanup: delete ${el.type}`, false, r.text); // the reason, IDs masked
  }
  report.check(
    "cleanup: every created element deleted, each backed up first",
    deleted === created.length,
    `${deleted}/${created.length}`,
  );
  report.check(
    "cleanup: ledger holds none of this run's elements",
    created.every((c) => !ledger.has(c.id)),
  );
  report.check(
    "harness refused no call",
    guard.refused.length === 0,
    guard.refused.join("; ") || undefined,
  );
  const backups = readdirSync(backupDir, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".json"),
  ).length;
  report.quirks.backupsTakenDuringRun = backups;
  rmSync(backupDir, { recursive: true, force: true });
  report.write(REPORT_FILE);
  console.log(`\n${report.summary()}\n\nFull report: ${REPORT_FILE}`);
  report.assertAllPassed();
});

describe("live write: articles", () => {
  let orgId: string;
  let personId: string;

  it("delete is hidden with the default configuration", async () => {
    const tools = await (await server(false)).tools();
    report.check("wa_delete absent from the default tool list", !tools.includes("wa_delete"));
  });

  it("a dry run writes nothing", async () => {
    const before = ledger.all.length;
    const r = await alice("wa_create_article", {
      world_id: testWorldId,
      title: `${tag}Dry`,
      template: "person",
      dry_run: true,
    });
    report.check("dry run sends nothing", !r.isError && ledger.all.length === before);
  });

  it("creates an organization; a type given by name is reported as ignored", async () => {
    const r = await create("article", "wa_create_article", {
      world_id: testWorldId,
      title: `${tag}Org`,
      template: "organization",
      fields: { type: "Family", motto: "MCP test motto" },
    });
    orgId = r.id;
    report.check(
      "organization type by name reported as ignored",
      ignoredIn(r.text).includes("type"),
    );
    report.check("organization motto stored", storedIn(r.text).includes("motto"));
  });

  it("creates a person with template fields and a link", async () => {
    const r = await create("article", "wa_create_article", {
      world_id: testWorldId,
      title: `${tag}Person`,
      template: "person",
      fields: { firstname: "Testfirst", nickname: "MCP nick" },
      links: { organization: orgId },
    });
    personId = r.id;
    const stored = storedIn(r.text);
    report.check(
      "person template fields stored",
      stored.includes("firstname") && stored.includes("nickname"),
    );
    report.check("person link stored", stored.includes("organization"));
    report.quirks.personCreateIgnored = ignoredIn(r.text);
  });

  it("refuses an unknown field of a probed template before sending", async () => {
    const r = await alice("wa_update_article", { id: personId, fields: { notARealField: "x" } });
    report.check("unknown person field refused", r.isError && /Unknown field/.test(r.text));
  });

  it("updates the person, then refuses a conflicting edit from another session", async () => {
    await alice("wa_get", { type: "article", id: personId });
    const u = await alice("wa_update_article", {
      id: personId,
      fields: { nickname: "MCP nick 2" },
    });
    report.check(
      "update stored",
      !u.isError && storedIn(u.text).includes("nickname"),
      u.isError ? u.text.slice(0, 160) : undefined,
    );

    await bob("wa_get", { type: "article", id: personId });
    const b = await bob("wa_update_article", {
      id: personId,
      fields: { nickname: "MCP nick from B" },
    });
    report.check("second session update stored", !b.isError);
    const a = await alice("wa_update_article", {
      id: personId,
      fields: { nickname: "MCP nick 3" },
    });
    report.check("conflicting edit refused", a.isError && /changed by someone else/.test(a.text));
  });

  it("restores the person from the first backup", async () => {
    await alice("wa_get", { type: "article", id: personId });
    const list = await alice("wa_restore", { type: "article", id: personId });
    const ids = [...list.text.matchAll(/"backup_id": "([^"]+)"/g)].map((m) => m[1]!);
    const oldest = ids.at(-1);
    report.check("backups listed", ids.length >= 2, `${ids.length}`);
    const r = await alice("wa_restore", { type: "article", id: personId, backup_id: oldest });
    const after = await rawGet("article", personId, "2");
    report.check(
      "restore puts the first value back",
      !r.isError && after.nickname === "MCP nick",
      r.isError ? r.text.slice(0, 160) : undefined,
    );
    report.quirks.restoreIgnored = ignoredIn(r.text);
  });
});

describe("live write: types not observed in stage A", () => {
  it("creates a subscriber group, a timeline, a history event and a child category, then reads them back", async () => {
    const sg = await create("subscribergroup", "wa_create", {
      type: "subscribergroup",
      data: { title: `${tag}Group`, world: { id: testWorldId } },
    });
    const tl = await create("timeline", "wa_create", {
      type: "timeline",
      data: { title: `${tag}Timeline`, world: { id: testWorldId } },
    });
    const hi = await create("history", "wa_create", {
      type: "history",
      data: {
        title: `${tag}Event`,
        world: { id: testWorldId },
        timelines: [{ id: tl.id }],
        year: "1",
      },
    });
    report.check(
      "history linked to its timeline",
      storedIn(hi.text).includes("timelines"),
      `ignored: ${ignoredIn(hi.text).join(", ")}`,
    );
    const parent = await create("category", "wa_create", {
      type: "category",
      data: { title: `${tag}Parent`, world: { id: testWorldId } },
    });
    const child = await create("category", "wa_create", {
      type: "category",
      data: { title: `${tag}Child`, world: { id: testWorldId }, parent: { id: parent.id } },
    });
    report.check(
      "child category parent stored",
      storedIn(child.text).includes("parent"),
      `ignored: ${ignoredIn(child.text).join(", ")}`,
    );

    for (const [type, id] of [
      ["subscribergroup", sg.id],
      ["timeline", tl.id],
      ["history", hi.id],
      ["category", child.id],
    ] as const) {
      await observe(type, id);
      for (const g of ["-1", REGISTRY[type]!.defaultGranularity]) {
        const r = await alice("wa_get", { type, id, granularity: g });
        report.check(`wa_get ${type} at granularity ${g} resolves its world`, !r.isError);
      }
    }
  });
});
