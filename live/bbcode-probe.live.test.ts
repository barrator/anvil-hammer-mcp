/**
 * BBCode probe (stage C, step 0): read-only. Reads every element of the test
 * world that has BBCode text and counts the forms World Anvil really stores,
 * so the converter can be built on facts. No text is recorded.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:bbcode
 *
 * Writes live-bbcode-report.json (gitignored) and prints a summary safe to paste.
 * The report's `localOnly` section lists unknown tag names, which may be your
 * own words written in brackets: look at it locally, do not paste it.
 */
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Json, WorldAnvilClient } from "../src/api/client.js";
import { loadSecrets } from "../src/config/secrets.js";
import { REGISTRY } from "../src/registry/index.js";
import { bbcodeToMarkdown, markdownToBbcode } from "../src/content/bbcode.js";
import { knownFields } from "../src/write/fields.js";
import {
  KNOWN_TAGS,
  emptyInventory,
  scanBbcodeField,
  scanUnflaggedField,
  shareable,
} from "./bbcode-inventory.js";
import { Ledger, createGuardedFetch, loadLiveConfig } from "./harness.js";

const REPORT_FILE = process.env.WA_LIVE_BBCODE_REPORT ?? "live-bbcode-report.json";
/** Safety cap on element reads: at 750 ms per call, 300 reads take about 4 minutes. */
const MAX_READS = 300;
const TYPES = ["article", "category", "secret", "timeline", "history", "subscribergroup"] as const;

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

describe("BBCode probe", () => {
  it("counts the BBCode forms stored in the test world", async () => {
    const inv = emptyInventory();
    // Converter check on real text: BBCode → Markdown → BBCode must give the same bytes.
    const roundTrip = {
      identical: 0,
      different: 0,
      modes: {} as Counter,
      withPlaceholders: 0,
      shownWholeRaw: 0,
      differentFields: {} as Counter,
      /** "field: reason" for each field left in plain mode (rule names only). */
      plainModeReasons: {} as Counter,
      /** What the remaining ⟦…⟧ placeholders hold, by kind (known WA tag names only). */
      placeholderKinds: {} as Counter,
    };
    const inc = (c: Counter, k: string) => (c[k] = (c[k] ?? 0) + 1);
    /**
     * Kind of a placeholder: the converter's rule name, plus the tag name when it
     * is a known World Anvil tag (unknown names could be the owner's words).
     */
    const kindOf = (raw: string, shape: string): string => {
      const tag = /^\[\/?([A-Za-z][A-Za-z0-9_-]{0,30})/.exec(raw)?.[1]?.toLowerCase();
      const withTag =
        shape.startsWith("tag in") ||
        shape.startsWith("inline tag") ||
        shape.startsWith("unpaired");
      if (!withTag || !tag) return shape;
      return `${shape}: ${KNOWN_TAGS.has(tag) ? `[${tag}]` : "unknown tag"}`;
    };
    const checkRoundTrip = (field: string, bb: string) => {
      if (bb === "") return;
      const v = bbcodeToMarkdown(bb);
      roundTrip.modes[v.mode] = (roundTrip.modes[v.mode] ?? 0) + 1;
      if (v.hasPlaceholders) roundTrip.withPlaceholders++;
      if (v.rawFallback) roundTrip.shownWholeRaw++;
      if (v.fallbackReason) {
        const detail = v.fallbackDetail ? ` (${v.fallbackDetail})` : "";
        inc(roundTrip.plainModeReasons, `${field}: ${v.fallbackReason}${detail}`);
      }
      v.placeholderRaws.forEach((raw, k) =>
        inc(roundTrip.placeholderKinds, kindOf(raw, v.placeholderShapes[k] ?? "other")),
      );
      if (markdownToBbcode(v.markdown, v.layout) === bb) roundTrip.identical++;
      else {
        roundTrip.different++;
        roundTrip.differentFields[field] = (roundTrip.differentFields[field] ?? 0) + 1;
      }
    };
    const elements: Counter = {};
    let reads = 0;
    let capped = false;

    for (const type of TYPES) {
      const def = REGISTRY[type]!;
      const { items } = await client.listAll(def.list!.path, testWorldId);
      elements[type] = items.length;
      for (const item of items) {
        if (typeof item.id !== "string") continue;
        if (reads >= MAX_READS) {
          capped = true;
          break;
        }
        reads++;
        const el = await client.request<Json>("GET", def.path, {
          id: item.id,
          granularity: def.backupGranularity,
        });
        const template = typeof el.templateType === "string" ? el.templateType : undefined;
        const fields = knownFields(def, template);
        for (const [name, value] of Object.entries(el)) {
          if (typeof value !== "string") continue;
          if (fields[name]?.bbcode) {
            scanBbcodeField(inv, type, name, value);
            checkRoundTrip(name, value);
          } else scanUnflaggedField(inv, `${template ?? type}.${name}`, value);
        }
      }
    }

    const shared = shareable(inv);
    writeFileSync(
      REPORT_FILE,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          elementsListed: elements,
          elementsRead: reads,
          capped,
          harnessRefused: guard.refused.length,
          inventory: shared,
          roundTrip,
          localOnly: inv.localOnly,
        },
        null,
        2,
      ) + "\n",
    );

    const j = (o: object) => JSON.stringify(o);
    const tags = Object.entries(shared.tags)
      .sort((a, b) => b[1].open + b[1].close - (a[1].open + a[1].close))
      .map(
        ([n, t]) =>
          `${n}(${t.open}/${t.close}${Object.keys(t.params).some((k) => k !== "none") ? " " + j(t.params) : ""}${t.notLowercase ? ` upper:${t.notLowercase}` : ""})`,
      )
      .join(", ");
    console.log(
      [
        "",
        "BBCode probe — counts and WA tag names only, safe to paste",
        `elements listed ${j(elements)}; read ${reads}${capped ? " (capped)" : ""}; harness refused ${guard.refused.length}`,
        `fields scanned ${inv.fieldsScanned} (empty ${inv.fieldsEmpty}, with tags ${inv.fieldsWithTags}); by field ${j(inv.byField)}`,
        `tags (open/close): ${tags}`,
        `unknown tags: ${shared.unknownTags.distinctNames} distinct names, ${shared.unknownTags.occurrences} occurrences (names in localOnly, do not paste)`,
        `paragraphs: ${j(inv.paragraphs)}`,
        `line breaks: ${j(inv.lineBreaks)}`,
        `raw newlines: ${j(inv.newlines)}`,
        `headings: ${j(inv.headings)}`,
        `mentions: ${j(inv.mentions)}`,
        `links: ${j(inv.links)}`,
        `sidebar lines: ${inv.sidebarLines}; placeholder chars ⟦⟧: ${inv.placeholderChars}`,
        `list item separators: ${j(inv.lists.itemSeparators)}`,
        `markdown chars in plain text: ${j(inv.markdownChars)}`,
        `typography: ${j(inv.typography)}`,
        `unflagged fields with tags: ${j(inv.unflaggedFieldsWithTags)}`,
        `round trip BBCode → Markdown → BBCode: ${j(roundTrip)}`,
        `Full report: ${REPORT_FILE}`,
      ].join("\n"),
    );

    if (guard.refused.length) throw new Error(`Harness refused ${guard.refused.length} call(s).`);
    if (roundTrip.different)
      throw new Error(`${roundTrip.different} text field(s) did not round-trip byte for byte.`);
    expect(inv.fieldsScanned).toBeGreaterThan(0);
  });
});

type Counter = Record<string, number>;
