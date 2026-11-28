/**
 * Delete every element recorded in the live-test ledger (for a run that
 * stopped halfway). Goes through the harness: only ledger elements of the
 * test world can be deleted.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:cleanup
 */
import { describe, expect, it } from "vitest";
import { WorldAnvilApiError, WorldAnvilClient } from "../src/api/client.js";
import { loadSecrets } from "../src/config/secrets.js";
import { REGISTRY } from "../src/registry/index.js";
import { Ledger, TEST_PREFIX, createGuardedFetch, loadLiveConfig } from "./harness.js";

describe("live cleanup", () => {
  it("deletes every MCP-TEST- element in the ledger", async () => {
    for (const v of ["WA_APP_KEY_FILE", "WA_AUTH_TOKEN_FILE"]) {
      if (!process.env[v]) throw new Error(`Live tests read keys from files only: set ${v}.`);
    }
    const live = loadLiveConfig();
    const ledger = new Ledger(live.ledgerFile);
    const guard = createGuardedFetch(fetch, {
      testWorldId: live.testWorldId,
      ledger,
      readOnly: false,
    });
    const client = new WorldAnvilClient(loadSecrets(process.env), { fetch: guard.fetch });

    const entries = [...ledger.all].reverse(); // children were created after their parents
    let deleted = 0;
    let alreadyGone = 0;
    let failed = 0;
    for (const e of entries) {
      if (!e.title.startsWith(TEST_PREFIX)) {
        failed++;
        continue;
      }
      const path = REGISTRY[e.type]?.path ?? e.type;
      try {
        await client.request("DELETE", path, { id: e.id });
        deleted++;
      } catch (err) {
        if (err instanceof WorldAnvilApiError && err.kind === "not_found") {
          ledger.remove(e.id);
          alreadyGone++;
        } else failed++;
      }
    }
    console.log(
      `\nLive cleanup — ledger entries ${entries.length}: deleted ${deleted}, already gone ${alreadyGone}, failed ${failed}; ` +
        `left in ledger ${ledger.all.length}; harness refused ${guard.refused.length}`,
    );
    expect(failed).toBe(0);
    expect(ledger.all).toHaveLength(0);
  });
});
