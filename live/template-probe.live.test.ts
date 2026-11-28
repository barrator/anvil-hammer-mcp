/**
 * Template probe (stage B, step 0): read-only. Reads every article of the test
 * world at granularity 2 and records, per template, the field names it returns
 * beyond the generic article fields. No values are recorded.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:templates
 *
 * Writes live-template-report.json (gitignored) and prints a summary.
 */
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { loadSecrets } from "../src/config/secrets.js";
import { REGISTRY } from "../src/registry/index.js";
import { Ledger, createGuardedFetch, loadLiveConfig } from "./harness.js";
import { analyzeTemplates } from "./template-analysis.js";

const REPORT_FILE = process.env.WA_LIVE_TEMPLATE_REPORT ?? "live-template-report.json";
/** Safety cap: at 750 ms per call, 200 articles take about 2.5 minutes. */
const MAX_ARTICLES = 200;

let client: WorldAnvilClient;
let guard: ReturnType<typeof createGuardedFetch>;
let testWorldId: string;

beforeAll(() => {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
  const secrets = loadSecrets(process.env);
  const live = loadLiveConfig();
  testWorldId = live.testWorldId;
  guard = createGuardedFetch(fetch, {
    testWorldId,
    ledger: new Ledger(live.ledgerFile),
    readOnly: true,
  });
  client = new WorldAnvilClient(secrets, { fetch: guard.fetch });
});

describe("template probe", () => {
  it("records template-specific fields at granularity 2", async () => {
    const { items } = await client.listAll("world/articles", testWorldId);
    const ids = items
      .map((a) => a.id)
      .filter((id): id is string => typeof id === "string")
      .slice(0, MAX_ARTICLES);

    const bodies: Json[] = [];
    for (const id of ids)
      bodies.push(await client.request<Json>("GET", "article", { id, granularity: "2" }));

    const analysis = analyzeTemplates(bodies, Object.keys(REGISTRY.article!.fields));
    const report = {
      generatedAt: new Date().toISOString(),
      articlesListed: items.length,
      articlesRead: bodies.length,
      capped: items.length > MAX_ARTICLES,
      harnessRefused: guard.refused.length,
      ...analysis,
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + "\n");

    const lines = [
      "Template probe — structure only, no real data",
      `articles listed ${items.length}, read ${bodies.length}${report.capped ? " (capped)" : ""}; generic basis: ${analysis.genericBasis}; harness refused ${guard.refused.length}`,
      "",
    ];
    for (const [t, info] of Object.entries(analysis.templates)) {
      const fields = Object.entries(info.specific).map(
        ([f, s]) => `${f}:${s.kinds.join("|")}(${s.nonEmpty})`,
      );
      lines.push(
        `${t} — ${info.articles} article(s), ${fields.length} specific field(s):`,
        `  ${fields.join(", ")}`,
        "",
      );
    }
    console.log(`\n${lines.join("\n")}\nFull report: ${REPORT_FILE}`);

    // Any harness refusal fails the run.
    if (guard.refused.length) throw new Error(`Harness refused ${guard.refused.length} call(s).`);
    expect(guard.refused).toEqual([]);
    expect(bodies.length).toBeGreaterThan(0);
  });
});
