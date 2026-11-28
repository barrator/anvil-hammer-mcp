/**
 * Stage E timeline test: writes MCP-TEST- elements only, in the test world,
 * through the harness. Never touches timelines or events made by hand: it
 * creates its own two "parallel" timelines and attaches its events to them.
 *
 * Creates: two timelines; events without a lane, with a lane, on both
 * timelines with a lane each, with an end but no end year, and with a full
 * end. Reads them back (structure only) and KEEPS them for a visual check on
 * the site; afterwards run npm run test:live:cleanup.
 *
 *   WA_APP_KEY_FILE=/path/app-key WA_AUTH_TOKEN_FILE=/path/auth-token npm run test:live:timeline
 *
 * Writes live-timeline-report.json (gitignored) and prints a summary with no real data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "../src/api/client.js";
import { normalizeUpdateDate } from "../src/session.js";
import { idOf, observeElement } from "./observe.js";
import { LiveReport } from "./report.js";
import {
  type LiveSession,
  checkPrivateDraft,
  createdId,
  ignoredIn,
  openLiveSession,
  storedIn,
} from "./session.js";

const REPORT_FILE = process.env.WA_LIVE_TIMELINE_REPORT ?? "live-timeline-report.json";
const report = new LiveReport();
let s: LiveSession;
const created: { type: string; id: string; what: string }[] = [];
let timelineA = "";
let timelineB = "";

beforeAll(async () => {
  s = await openLiveSession();
  report.hide(s.testWorldId);
});

afterAll(() => {
  if (!s) return;
  report.hide(...created.map((c) => c.id));
  report.check(
    "every created element is in the ledger (test:live:cleanup can delete it)",
    created.every((c) => s.ledger.has(c.id)),
  );
  report.check(
    "harness refused no call",
    s.guard.refused.length === 0,
    s.guard.refused.join("; ") || undefined,
  );
  report.quirks.keptForVisualCheck = created.map((c) => `${c.type}: ${c.what}`);
  report.write(REPORT_FILE);
  console.log(
    `\n${report.summary()}\n\nKept in the test world for your visual check (titles start with ${s.tag}):\n` +
      created.map((c) => `  - ${c.type}: ${c.what}`).join("\n") +
      `\nThen run npm run test:live:cleanup.\n\nFull report: ${REPORT_FILE}`,
  );
  report.assertAllPassed();
});

async function readBack(id: string): Promise<Json> {
  const el = await s.raw.request<Json>("GET", "history", { id, granularity: "2" });
  observeElement(report, "history", "2", el);
  return el;
}

/** Shape of a lane value without any id: kind, keys, values. */
function laneShape(el: Json, expectTimelines: string[]) {
  const lane = el.lane;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed =
      typeof lane === "string" && lane ? (JSON.parse(lane) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    kind: lane === null || lane === undefined ? String(lane) : typeof lane,
    keys: parsed ? Object.keys(parsed).length : 0,
    keysAreTheTimelines: parsed
      ? Object.keys(parsed).every((k) => expectTimelines.includes(k))
      : null,
    values: parsed ? Object.values(parsed) : [],
  };
}

describe("live timeline: parallel timelines and lanes", () => {
  it("creates two MCP-TEST timelines of type parallel", async () => {
    for (const [name, set] of [
      ["Parallel A", (id: string) => (timelineA = id)],
      ["Parallel B", (id: string) => (timelineB = id)],
    ] as const) {
      const r = await s.call("wa_create", {
        type: "timeline",
        data: { title: `${s.tag}${name}`, world: { id: s.testWorldId }, type: "parallel" },
      });
      report.check(`create timeline ${name}`, !r.isError, r.isError ? r.text : undefined);
      expect(r.isError, r.text).toBe(false);
      const id = createdId(r.text)!;
      report.hide(id);
      set(id);
      created.push({ type: "timeline", id, what: `${name} (type parallel)` });
      report.quirks[`timeline ${name}: type stored`] = storedIn(r.text).includes("type");
      await checkPrivateDraft(report, s.raw, "timeline", id);
    }
  });

  const event = async (
    what: string,
    args: Record<string, unknown>,
    tool = "wa_upsert_timeline_event",
  ) => {
    const r = await s.call(tool, args);
    report.check(`create event: ${what}`, !r.isError, r.isError ? r.text : undefined);
    expect(r.isError, r.text).toBe(false);
    const id = createdId(r.text)!;
    report.hide(id);
    created.push({ type: "history", id, what });
    await checkPrivateDraft(report, s.raw, "history", id);
    return { id, text: r.text };
  };

  it("creates events without a lane, with a lane, and on both timelines", async () => {
    const before = await s.raw.request<Json>("GET", "timeline", {
      id: timelineA,
      granularity: "2",
    });

    const e1 = await event("on A, no lane", {
      world_id: s.testWorldId,
      title: `${s.tag}No lane`,
      timelines: [{ id: timelineA }],
      start: { year: "1" },
    });
    const e2 = await event("on A, lane 3", {
      world_id: s.testWorldId,
      title: `${s.tag}Lane 3`,
      timelines: [{ id: timelineA, lane: 3 }],
      start: { year: "2", month: 1, day: 1 },
    });
    const e3 = await event("on A (lane 2) and B (lane 4)", {
      world_id: s.testWorldId,
      title: `${s.tag}Two timelines`,
      timelines: [
        { id: timelineA, lane: 2 },
        { id: timelineB, lane: 4 },
      ],
      start: { year: "3" },
    });

    const shapes: Json = {};
    for (const [label, e, tls] of [
      ["no lane", e1, [timelineA]],
      ["lane 3", e2, [timelineA]],
      ["two timelines", e3, [timelineA, timelineB]],
    ] as const) {
      const el = await readBack(e.id);
      shapes[label] = {
        lane: laneShape(el, [...tls]),
        timelines: Array.isArray(el.timelines) ? (el.timelines as Json[]).length : 0,
        laneStored: storedIn(e.text).includes("lane"),
        laneIgnored: ignoredIn(e.text).includes("lane"),
      };
    }
    report.quirks.lanes = shapes;

    const after = await s.raw.request<Json>("GET", "timeline", { id: timelineA, granularity: "2" });
    report.quirks.addingEventsChangesTimelineUpdateDate =
      normalizeUpdateDate(before.updateDate) !== normalizeUpdateDate(after.updateDate);
    report.quirks.timelineHistoriesAfter = Array.isArray(after.histories)
      ? (after.histories as Json[]).length
      : null;
  });

  it("changes a lane on update and keeps the others", async () => {
    const e = created.find((c) => c.what.startsWith("on A (lane 2)"))!;
    await s.call("wa_get", { type: "history", id: e.id });
    const r = await s.call("wa_upsert_timeline_event", {
      id: e.id,
      timelines: [
        { id: timelineA, lane: 5 },
        { id: timelineB, lane: 4 },
      ],
    });
    report.check("update lane", !r.isError, r.isError ? r.text : undefined);
    const el = await readBack(e.id);
    const shape = laneShape(el, [timelineA, timelineB]);
    report.quirks.laneAfterUpdate = shape;
    report.check("lane after update holds both timelines", shape.keys === 2);
  });
});

describe("live timeline: dates", () => {
  it("creates an event with an end but no end year (generic tool), and one with a full end", async () => {
    // The specialized tool refuses an end without a year; the generic tool sends what it is given.
    const r1 = await s.call("wa_create", {
      type: "history",
      data: {
        title: `${s.tag}End without end year`,
        world: { id: s.testWorldId },
        timelines: [{ id: timelineA }],
        year: "4",
        month: 2,
        endingMonth: 3,
        endingDay: 4,
      },
    });
    report.check(
      "create event with end but no end year",
      !r1.isError,
      r1.isError ? r1.text : undefined,
    );
    const id1 = createdId(r1.text)!;
    report.hide(id1);
    created.push({
      type: "history",
      id: id1,
      what: "on A, year 4, end month 3 day 4, NO end year",
    });
    await checkPrivateDraft(report, s.raw, "history", id1);

    const refused = await s.call("wa_upsert_timeline_event", {
      world_id: s.testWorldId,
      title: `${s.tag}Refused`,
      timelines: [{ id: timelineA }],
      start: { year: "4" },
      end: { month: 3 },
    });
    report.check("the specialized tool refuses an end without a year", refused.isError);

    const r2 = await s.call("wa_upsert_timeline_event", {
      world_id: s.testWorldId,
      title: `${s.tag}Full end`,
      timelines: [{ id: timelineA, lane: 1 }],
      start: { year: "5", month: 6, day: 7, hour: 8, minute: 9 },
      end: { year: "6", month: 1, day: 2, hour: 3, minute: 4 },
    });
    report.check("create event with a full end", !r2.isError, r2.isError ? r2.text : undefined);
    const id2 = createdId(r2.text)!;
    report.hide(id2);
    created.push({ type: "history", id: id2, what: "on A, 5-6-7 8:09 to 6-1-2 3:04, lane 1" });

    const kinds: Json = {};
    for (const id of [id1, id2]) {
      const el = await readBack(id);
      for (const k of [
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "endingYear",
        "endingMonth",
        "endingDay",
        "endingHour",
        "endingMinute",
      ])
        kinds[`${idOf(el) === id1 ? "noEndYear" : "fullEnd"}.${k}`] =
          el[k] === null || el[k] === undefined || el[k] === "" ? "empty" : typeof el[k];
    }
    report.quirks.dateKinds = kinds;
    report.quirks.fullEndIgnored = ignoredIn(r2.text);
  });
});
