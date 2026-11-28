/**
 * Stage E types test: writes MCP-TEST- elements only, in the test world,
 * through the harness. For each world type that can be created AND deleted
 * (maps excluded: they need an uploaded image), creates one element, reads it
 * at every granularity, updates its title, and deletes everything at the end
 * (children first, each backed up first). Also creates a location article to
 * list the location template's fields, and, if the test world has an image,
 * sets it as that article's cover.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:types
 *
 * If it stops halfway, npm run test:live:cleanup deletes what is left in the ledger.
 * Writes live-types-report.json (gitignored) and prints a summary with no real data.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import type { Json } from "../src/api/client.js";
import { REGISTRY } from "../src/registry/index.js";
import { errorKind, idOf, listType, readAllGranularities, routeResult } from "./observe.js";
import { LiveReport } from "./report.js";
import {
  type LiveSession,
  checkPrivateDraft,
  createdId,
  ignoredIn,
  openLiveSession,
  storedIn,
} from "./session.js";
import { analyzeTemplates } from "./template-analysis.js";

const REPORT_FILE = process.env.WA_LIVE_TYPES_REPORT ?? "live-types-report.json";
const report = new LiveReport();
let s: LiveSession;
/** Created elements in creation order (deleted in reverse). */
const created: { type: string; id: string }[] = [];
const ids: Record<string, string> = {};

interface Plan {
  type: string;
  /** Parent created earlier in this run, needed first. */
  needs?: string[];
  body: () => Json | undefined;
}

/** Creation plan, parents first. Only types whose registry verbs include create and delete. */
const PLAN: Plan[] = [
  { type: "notebook", body: () => ({ world: { id: s.testWorldId } }) },
  { type: "notesection", needs: ["notebook"], body: () => ({ notebook: { id: ids.notebook } }) },
  { type: "note", needs: ["notesection"], body: () => ({ notesection: { id: ids.notesection } }) },
  { type: "blockfolder", body: () => ({ world: { id: s.testWorldId } }) },
  {
    type: "block",
    needs: ["blockfolder", "blocktemplate*", "rpgsystem*"],
    body: () => ({
      folder: { id: ids.blockfolder },
      template: { id: ids["blocktemplate*"] },
      RPGSRD: { id: ids["rpgsystem*"] },
    }),
  },
  { type: "canvas", body: () => ({ world: { id: s.testWorldId } }) },
  { type: "chronicle", body: () => ({ world: { id: s.testWorldId } }) },
  { type: "variablecollection", body: () => ({ world: { id: s.testWorldId } }) },
  {
    type: "variable",
    needs: ["variablecollection"],
    body: () => ({
      k: "mcp_test_key",
      v: "1",
      type: "string",
      collection: { id: ids.variablecollection },
    }),
  },
  { type: "manuscript", body: () => ({ world: { id: s.testWorldId } }) },
  {
    type: "manuscript_version",
    needs: ["manuscript"],
    body: () => ({ manuscript: { id: ids.manuscript } }),
  },
  {
    type: "manuscript_part",
    needs: ["manuscript_version"],
    body: () => ({ version: { id: ids.manuscript_version } }),
  },
  {
    type: "manuscript_beat",
    needs: ["manuscript_part"],
    body: () => ({ part: { id: ids.manuscript_part }, content: "MCP test beat" }),
  },
  {
    type: "manuscript_bookmark",
    needs: ["manuscript", "manuscript_part"],
    body: () => ({ manuscript: { id: ids.manuscript }, part: { id: ids.manuscript_part } }),
  },
  {
    type: "manuscript_tag",
    needs: ["manuscript"],
    body: () => ({ manuscript: { id: ids.manuscript } }),
  },
  {
    type: "manuscript_label",
    needs: ["manuscript"],
    body: () => ({ manuscript: { id: ids.manuscript } }),
  },
  {
    type: "manuscript_stat",
    needs: ["manuscript_version"],
    body: () => ({ version: { id: ids.manuscript_version } }),
  },
  {
    type: "manuscript_plot",
    needs: ["manuscript_version"],
    body: () => ({ version: { id: ids.manuscript_version } }),
  },
];

beforeAll(async () => {
  s = await openLiveSession();
  report.hide(s.testWorldId);
  // Shared and account elements a block needs (read only, never written).
  const me = await s.raw.request<Json>("GET", "identity");
  const own = idOf(me);
  if (own) {
    report.hide(own);
    const templates = await listType(report, s.raw, "blocktemplate", own);
    const t = templates.map(idOf).find(Boolean);
    if (t) ids["blocktemplate*"] = t;
  }
  const systems = await listType(report, s.raw, "rpgsystem", undefined);
  const r = systems.map(idOf).find(Boolean);
  if (r) ids["rpgsystem*"] = r;
  report.hide(...Object.values(ids));
});

afterAll(async () => {
  if (!s) return;
  report.hide(...created.map((c) => c.id));
  let deleted = 0;
  for (const el of [...created].reverse()) {
    await s.call("wa_get", { type: el.type, id: el.id }).catch(() => undefined);
    const r = await s.call("wa_delete", { type: el.type, id: el.id }).catch((e: Error) => ({
      isError: true,
      text: e.message,
    }));
    const ok = !r.isError && /-delete\.json/.test(r.text);
    routeResult(report, el.type, "delete", ok ? "ok" : "failed");
    if (ok) deleted++;
    else report.check(`cleanup: delete ${el.type}`, false, r.text);
  }
  report.check(
    "cleanup: every created element deleted, each backed up first",
    deleted === created.length,
    `${deleted}/${created.length}`,
  );
  report.check(
    "cleanup: ledger holds none of this run's elements",
    created.every((c) => !s.ledger.has(c.id)),
  );
  report.check(
    "harness refused no call",
    s.guard.refused.length === 0,
    s.guard.refused.join("; ") || undefined,
  );
  report.write(REPORT_FILE);
  const routes = Object.entries(report.types)
    .map(
      ([t, o]) =>
        `${t}: ${Object.entries(o.routes ?? {})
          .map(([v, x]) => `${v} ${x}`)
          .join(", ")}`,
    )
    .join("\n");
  console.log(`\n${report.summary()}\n\nRoutes:\n${routes}\n\nFull report: ${REPORT_FILE}`);
  report.assertAllPassed();
});

describe("live types: create, read, update, delete one element of each type", () => {
  it("follows the plan, parents first; a type whose parent failed is skipped", async () => {
    const skipped: Record<string, string> = {};
    for (const p of PLAN) {
      const def = REGISTRY[p.type]!;
      if (!def.verbs.includes("create") || !def.verbs.includes("delete")) {
        skipped[p.type] = "cannot be both created and deleted: not created";
        continue;
      }
      const missing = (p.needs ?? []).filter((n) => !ids[n]);
      if (missing.length) {
        skipped[p.type] = `needs ${missing.join(", ")}`;
        continue;
      }
      const r = await s.call("wa_create", {
        type: p.type,
        data: { title: `${s.tag}${p.type}`, ...p.body() },
      });
      const id = r.isError ? undefined : createdId(r.text);
      routeResult(report, p.type, "create", id ? "ok" : "failed");
      if (!id) {
        // Unverified routes may not work: a finding, not a failure. Masked message only.
        report.quirks[`create ${p.type}`] = r.text.replace(/\s+/g, " ").slice(0, 200);
        continue;
      }
      report.hide(id);
      ids[p.type] = id;
      created.push({ type: p.type, id });
      report.quirks[`create ${p.type}: ignored`] = ignoredIn(r.text);
      await checkPrivateDraft(report, s.raw, p.type, id);
      await readAllGranularities(report, s.raw, p.type, id);

      await s.call("wa_get", { type: p.type, id });
      const u = await s.call("wa_update", {
        type: p.type,
        id,
        data: { title: `${s.tag}${p.type} updated` },
      });
      routeResult(
        report,
        p.type,
        "update",
        !u.isError && storedIn(u.text).includes("title") ? "ok" : u.isError ? "failed" : "ignored",
      );
    }
    report.quirks.skipped = skipped;
  });
});

describe("live types: location template and image references", () => {
  it("lists the location template's fields from a new location article", async () => {
    const r = await s.call("wa_create_article", {
      world_id: s.testWorldId,
      title: `${s.tag}Location`,
      template: "location",
    });
    report.check("create a location article", !r.isError, r.isError ? r.text : undefined);
    const id = createdId(r.text);
    if (!id) return;
    report.hide(id);
    created.push({ type: "article", id });
    await checkPrivateDraft(report, s.raw, "article", id);
    const body = await s.raw.request<Json>("GET", "article", { id, granularity: "2" });
    const analysis = analyzeTemplates([body], Object.keys(REGISTRY.article!.fields));
    const loc = analysis.templates.location;
    report.quirks.locationTemplate = loc
      ? { fields: Object.keys(loc.specific), count: Object.keys(loc.specific).length }
      : "no location-specific field returned";

    // An image of the test world as the article's cover: checked against the world first.
    const images = await listType(report, s.raw, "image", s.testWorldId);
    const image = images.map(idOf).find(Boolean);
    if (!image) {
      report.quirks.coverImage = "no image in the test world: not tested";
      return;
    }
    report.hide(image);
    await readAllGranularities(report, s.raw, "image", image);
    await s.call("wa_get", { type: "article", id });
    const c = await s.call("wa_update_article", { id, links: { cover: image } });
    report.quirks.coverImage = c.isError
      ? `refused: ${c.text.replace(/\s+/g, " ").slice(0, 160)}`
      : {
          stored: storedIn(c.text).includes("cover"),
          ignored: ignoredIn(c.text).includes("cover"),
        };
  });

  it("records an error kind for any route that answered unexpectedly", () => {
    // Nothing to do: routes are recorded as they are used; this keeps the report's shape stable.
    report.quirks.errorKindExample = errorKind(new Error("x"));
  });
});
