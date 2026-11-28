/**
 * A real MCP server for the stage E write tests, wired to World Anvil through
 * the harness only (writes limited to MCP-TEST- elements of the test world,
 * recorded in the ledger).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { AccessPolicy } from "../src/config/access.js";
import type { Config } from "../src/config/index.js";
import { loadSecrets } from "../src/config/secrets.js";
import { DEFAULT_MAX_RESPONSE_CHARS } from "../src/constants.js";
import { REGISTRY } from "../src/registry/index.js";
import { createServer } from "../src/server.js";
import { Ledger, TEST_PREFIX, createGuardedFetch, loadLiveConfig } from "./harness.js";
import type { LiveReport } from "./report.js";

export type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;

export interface LiveSession {
  testWorldId: string;
  ledger: Ledger;
  guard: ReturnType<typeof createGuardedFetch>;
  raw: WorldAnvilClient;
  call: Call;
  /** MCP-TEST-<timestamp>- prefix for this run's titles. */
  tag: string;
  backupDir: string;
}

export async function openLiveSession(): Promise<LiveSession> {
  for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
    if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
  }
  const secrets = loadSecrets(process.env);
  const live = loadLiveConfig();
  const ledger = new Ledger(live.ledgerFile);
  const guard = createGuardedFetch(fetch, {
    testWorldId: live.testWorldId,
    ledger,
    readOnly: false,
  });
  const backupDir = mkdtempSync(join(tmpdir(), "ahm-live-e-"));
  const config: Config = {
    secrets,
    access: new AccessPolicy(new Map([[live.testWorldId, "full_edit"]])),
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    backupDir,
    backupRetentionDays: 1,
    enableDelete: true,
  };
  const server = createServer(config, { clientOptions: { fetch: guard.fetch } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "live-stage-e", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call: Call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      isError: r.isError === true,
      text: (r.content as { text: string }[]).map((x) => x.text).join("\n"),
    };
  };
  return {
    testWorldId: live.testWorldId,
    ledger,
    guard,
    raw: new WorldAnvilClient(secrets, { fetch: guard.fetch }),
    call,
    tag: `${TEST_PREFIX}${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}-`,
    backupDir,
  };
}

/** Id of the element a write result reports, from its untrusted block. */
export function createdId(text: string): string | undefined {
  const m = /<untrusted_world_content source="[a-z_]+:([^"]+)">/.exec(text);
  return m && m[1] !== "new" ? m[1] : undefined;
}

const line = (text: string, re: RegExp) =>
  re
    .exec(text)?.[1]
    ?.split(", ")
    .map((s) => s.replace(/\.$/, "")) ?? [];
export const ignoredIn = (text: string) => line(text, /did NOT store: ([^\n]+)/);
export const storedIn = (text: string) => line(text, /Stored: ([^\n]+)/);

/** Every created element must come back private (and draft where the type has it). */
export async function checkPrivateDraft(
  report: LiveReport,
  raw: WorldAnvilClient,
  type: string,
  id: string,
) {
  const def = REGISTRY[type]!;
  const el = await raw.request<Json>("GET", def.path, { id, granularity: def.backupGranularity });
  const hasState = "state" in def.fields;
  const hasDraft = "isDraft" in def.fields;
  if (!hasState && !hasDraft) return;
  // Strict, as in stage B: a missing state or isDraft is a registry error to fix, not a pass.
  const privateOk = !hasState || el.state === "private";
  const draftOk = !hasDraft || el.isDraft === true || el.isDraft === 1;
  report.check(
    `${type}: created ${[hasState && "private", hasDraft && "draft"].filter(Boolean).join(" and ")}`,
    privateOk && draftOk,
    privateOk && draftOk ? undefined : `state ${String(el.state)}, isDraft ${String(el.isDraft)}`,
  );
}
