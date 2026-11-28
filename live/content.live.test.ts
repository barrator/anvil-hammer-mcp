/**
 * Stage C live run: content fidelity in the test world, through the harness.
 * Creates MCP-TEST- articles written in Markdown (mixed formatting, a mention,
 * a sidebar key-value line) and one written in raw BBCode, reads them back,
 * appends, edits one paragraph, and checks the stored bytes.
 *
 * The articles are KEPT so the owner can check the rendering on World Anvil.
 * Afterwards: npm run test:live:cleanup.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:content
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { AccessPolicy } from "../src/config/access.js";
import type { Config } from "../src/config/index.js";
import { loadSecrets } from "../src/config/secrets.js";
import { DEFAULT_MAX_RESPONSE_CHARS } from "../src/constants.js";
import { createServer } from "../src/server.js";
import { Ledger, TEST_PREFIX, createGuardedFetch, loadLiveConfig } from "./harness.js";
import { LiveReport } from "./report.js";

const REPORT_FILE = process.env.WA_LIVE_CONTENT_REPORT ?? "live-content-report.json";
const report = new LiveReport();
const tag = `${TEST_PREFIX}${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}-`;
const NBSP = " ";
const NNBSP = " ";

let guard: ReturnType<typeof createGuardedFetch>;
let raw: WorldAnvilClient;
let backupDir: string;
let testWorldId: string;
type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;
let call: Call;
const titles: string[] = [];

const createdId = (text: string) => {
  const m = /<untrusted_world_content source="article:([^"]+)">/.exec(text);
  if (!m || m[1] === "new") throw new Error("no id in result");
  report.hide(m[1]!);
  return m[1]!;
};
const stored = async (id: string, field: string) =>
  String((await raw.request<Json>("GET", "article", { id, granularity: "2" }))[field] ?? "");
const markdownOf = (text: string, field: string) => {
  const m =
    /<untrusted_world_content source="[^"]*">\n([\s\S]*?)\n<\/untrusted_world_content>/.exec(text);
  return String((JSON.parse(m?.[1] ?? "{}") as Json)[field] ?? "");
};

beforeAll(async () => {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
  const secrets = loadSecrets(process.env);
  const live = loadLiveConfig();
  testWorldId = live.testWorldId;
  report.hide(testWorldId);
  guard = createGuardedFetch(fetch, {
    testWorldId,
    ledger: new Ledger(live.ledgerFile),
    readOnly: false,
  });
  raw = new WorldAnvilClient(secrets, { fetch: guard.fetch });
  backupDir = mkdtempSync(join(tmpdir(), "ahm-live-content-"));
  const config: Config = {
    secrets,
    access: new AccessPolicy(new Map([[testWorldId, "edit_only"]])),
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    backupDir,
    backupRetentionDays: 1,
    enableDelete: false,
  };
  const server = createServer(config, { clientOptions: { fetch: guard.fetch } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "live-content", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      isError: r.isError === true,
      text: (r.content as { text: string }[]).map((x) => x.text).join("\n"),
    };
  };
});

afterAll(() => {
  if (!guard) return;
  report.check(
    "harness refused no call",
    guard.refused.length === 0,
    guard.refused.join("; ") || undefined,
  );
  rmSync(backupDir, { recursive: true, force: true });
  report.write(REPORT_FILE);
  console.log(
    `\n${report.summary()}\n\nKept for you to check on World Anvil (then run npm run test:live:cleanup):\n` +
      titles.map((t) => `  - ${t}`).join("\n") +
      `\nFull report: ${REPORT_FILE}`,
  );
  report.assertAllPassed();
});

describe("live content: Markdown article with a mention and a sidebar line", () => {
  let targetId: string;
  let articleId: string;
  let sentContent: string;

  it("creates the mention target", async () => {
    const title = `${tag}Target`;
    const r = await call("wa_create_article", { world_id: testWorldId, title, template: "person" });
    report.check("create target", !r.isError, r.isError ? r.text : undefined);
    targetId = createdId(r.text);
    titles.push(title);
  });

  it("creates an article from Markdown in the editor's form", async () => {
    const title = `${tag}Formatting`;
    const md = [
      "## Section avec **gras** et *italique*",
      `Couleur principale${NBSP}: Gueules (rouge)\nCouleur secondaire${NBSP}: Sable (noir)`,
      `Le «${NBSP}roi${NBSP}» d’Orvane — dit-on… a parlé${NNBSP}! Voir @[${tag}Target](Article:${targetId}).`,
      "Dernier paragraphe.",
    ].join("\n\n");
    const r = await call("wa_create_article", {
      world_id: testWorldId,
      title,
      fields: { content: md, sidebarcontent: "--Population::12--" },
    });
    report.check("create formatted article", !r.isError, r.isError ? r.text : undefined);
    articleId = createdId(r.text);
    titles.push(title);
    sentContent =
      `[h2]Section avec [b]gras[/b] et [i]italique[/i][/h2]\n` +
      `[p]Couleur principale${NBSP}: Gueules (rouge)[br]Couleur secondaire${NBSP}: Sable (noir)[/p]\n` +
      `[p]Le «${NBSP}roi${NBSP}» d’Orvane — dit-on… a parlé${NNBSP}! Voir @[${tag}Target](Article:${targetId}).[/p]\n` +
      `[p]Dernier paragraphe.[/p]`;
    report.check(
      "stored content is exactly the editor form expected",
      (await stored(articleId, "content")) === sentContent,
    );
    report.check(
      "mention stored exactly as @[Title](Article:id)",
      (await stored(articleId, "content")).includes(`@[${tag}Target](Article:${targetId})`),
    );
    report.check(
      "sidebar key-value line stored untouched",
      (await stored(articleId, "sidebarcontent")) === "--Population::12--",
    );
  });

  it("reads it as Markdown, then appends without touching the rest", async () => {
    const read = await call("wa_get", { type: "article", id: articleId });
    report.check("read back as Markdown converts without placeholders", !read.text.includes("⟦"));
    const before = await stored(articleId, "content");
    const r = await call("wa_update_article", {
      id: articleId,
      append: { content: "Paragraphe *ajouté*." },
    });
    report.check("append accepted", !r.isError, r.isError ? r.text : undefined);
    const after = await stored(articleId, "content");
    report.check("append keeps the existing text byte for byte", after.startsWith(before));
    report.check(
      "append adds one editor-style paragraph",
      after === `${before}\n[p]Paragraphe [i]ajouté[/i].[/p]`,
    );
  });

  it("refuses to replace the text without replace_fields", async () => {
    await call("wa_get", { type: "article", id: articleId });
    const r = await call("wa_update_article", {
      id: articleId,
      fields: { content: "Tout nouveau." },
    });
    report.check(
      "replace without confirmation refused",
      r.isError && /replace_fields/.test(r.text),
    );
  });
});

describe("live content: hand-made BBCode survives a Markdown edit", () => {
  it("creates raw BBCode, edits one paragraph through Markdown, and checks every other byte", async () => {
    const title = `${tag}RawBBCode`;
    const original =
      "[p]Premier paragraphe.[/p]\n[p][/p]\n[p][section:mcp-test]Section [u]soulignée[/u][/section][/p]\n" +
      "[h3]Titre simple[/h3]\n[p]À modifier.[/p]\n[p][/p]";
    const c = await call("wa_create_article", {
      world_id: testWorldId,
      title,
      fields: { content: original },
      raw_bbcode: true,
    });
    report.check("create raw BBCode article", !c.isError, c.isError ? c.text : undefined);
    const id = createdId(c.text);
    titles.push(title);
    report.check("raw BBCode stored byte for byte", (await stored(id, "content")) === original);

    const read = await call("wa_get", { type: "article", id });
    const md = markdownOf(read.text, "content");
    report.check(
      "Markdown view keeps unknown tags as placeholders",
      md.includes("⟦[section:mcp-test]⟧") && md.includes("⟦[p][/p]⟧"),
    );
    const u = await call("wa_update_article", {
      id,
      fields: { content: md.replace("À modifier.", "Modifié.") },
      replace_fields: ["content"],
    });
    report.check("edit through Markdown accepted", !u.isError, u.isError ? u.text : undefined);
    report.check(
      "only the edited paragraph changed",
      (await stored(id, "content")) === original.replace("À modifier.", "Modifié."),
    );
  });
});
