/**
 * Specialized write tools for frequent tasks (stage E): a secret attached to an
 * article, and a dated timeline event. Both go through the same write service
 * as every other tool: access, references in the same world, conflicts, dry
 * run, backup, read-back; new elements are private.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../api/client.js";
import { createElement, updateElement, type WriteContext } from "../write/service.js";
import { ToolError, enabled, handler } from "./context.js";
import {
  CONFLICT_NOTE,
  TEXT_NOTE,
  WRITE,
  dryRun,
  expected,
  id,
  rawBbcode,
  render,
  replaceFields,
  textOptions,
} from "./write.js";

const stateSchema = z.enum(["private", "public"]).optional();
const appendSchema = z
  .record(z.string(), z.string().min(1))
  .optional()
  .describe(
    'Recommended way to edit text of an existing element: Markdown added at the end of a text field, e.g. {"content": "A new paragraph."}.',
  );

function refuseCreateOnly(given: Record<string, unknown>, names: string[]) {
  const extra = names.filter((n) => given[n] !== undefined);
  if (extra.length)
    throw new ToolError(`${extra.join(", ")}: only for creating (without id). Nothing was sent.`);
}

// ---------- secrets ----------

export function registerSecretTool(server: McpServer, ctx: WriteContext) {
  if (!enabled(ctx, "wa_upsert_secret")) return;
  server.registerTool(
    "wa_upsert_secret",
    {
      title: "Create or update a secret",
      description:
        "Without id: create a secret in a world (private by default), optionally attached to an article and " +
        "restricted to subscriber groups. With id: update only what is given. The article and the groups must be " +
        "in the same world. subscriber_group_ids replaces the list; [] removes the restriction." +
        CONFLICT_NOTE +
        TEXT_NOTE,
      inputSchema: {
        id: id("secret").optional().describe("Give it to update an existing secret."),
        world_id: id("world").optional().describe("Required to create."),
        title: z.string().trim().min(1).max(300).optional().describe("Required to create."),
        content: z.string().optional().describe("The secret's text, in Markdown."),
        article_id: z.string().trim().min(1).max(100).optional(),
        subscriber_group_ids: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
        state: stateSchema,
        append: appendSchema,
        replace_fields: replaceFields,
        raw_bbcode: rawBbcode,
        expected_update_date: expected,
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(ctx, "wa_upsert_secret", async (a, state) => {
      const body: Json = {};
      if (a.title) body.title = a.title;
      if (a.content !== undefined) body.content = a.content;
      if (a.article_id) body.article = { id: a.article_id };
      if (a.subscriber_group_ids)
        body.subscribergroups = a.subscriber_group_ids.map((x) => ({ id: x }));
      if (a.state) body.state = a.state;
      const links = [
        ...(a.article_id ? ["article"] : []),
        ...(a.subscriber_group_ids?.length ? ["subscribergroups"] : []),
      ];

      if (!a.id) {
        if (!a.world_id || !a.title)
          throw new ToolError("To create a secret, give world_id and title. Nothing was sent.");
        if (a.append)
          throw new ToolError("append is for an existing secret; give content to create.");
        return render(
          ctx,
          await createElement(ctx, state, {
            type: "secret",
            body: { ...body, world: { id: a.world_id } },
            strictTemplates: false,
            dryRun: a.dry_run,
            linkFields: links,
            text: textOptions(a.raw_bbcode),
          }),
        );
      }
      refuseCreateOnly(a, ["world_id"]);
      return render(
        ctx,
        await updateElement(ctx, state, {
          type: "secret",
          id: a.id,
          body,
          strictTemplates: false,
          dryRun: a.dry_run,
          expectedUpdateDate: a.expected_update_date,
          linkFields: links,
          text: textOptions(a.raw_bbcode, a.replace_fields, a.append),
        }),
      );
    }),
  );
}

// ---------- timeline events ----------

const int = (max: number) => z.number().int().min(0).max(max);

/** A date as World Anvil stores it: the year is text, the rest are integers (custom calendars allowed). */
const dateSchema = z
  .object({
    year: z
      .string()
      .trim()
      .regex(/^-?\d{1,12}$/, "year: a whole number, possibly negative, written as text")
      .describe('Required: the year, as text (e.g. "1032" or "-50").'),
    month: int(10_000).optional(),
    day: int(10_000).optional(),
    hour: int(1_000).optional(),
    minute: int(1_000).optional(),
  })
  .strict();

const timelineEntry = z
  .object({
    id: z.string().trim().min(1).max(100),
    lane: int(100)
      .optional()
      .describe('Column of the event in a "parallel" timeline (the editor\'s "Select Column").'),
  })
  .strict();

const eventLinks = z
  .object({
    article: z.string().trim().min(1).max(100).optional(),
    characters: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    organizations: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    location: z.string().trim().min(1).max(100).optional(),
    species: z.string().trim().min(1).max(100).optional(),
    report: z.string().trim().min(1).max(100).optional(),
    militaryConflict: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .optional()
  .describe("Articles of the same world the event is about (IDs).");

/** Parse a stored lane value: JSON text keyed by timeline id, e.g. {"<id>":5}. */
export function parseLane(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (!Number.isInteger(n)) return undefined;
      out[k] = n;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The lane value to send: the current lanes kept for timelines the event stays
 * on, the given lanes set. Keys are only the event's timelines.
 */
export function mergeLane(
  current: unknown,
  timelines: readonly { id: string; lane?: number }[],
): { lane?: string } {
  const before = parseLane(current);
  if (!before)
    throw new ToolError(
      "Refused: the event's current lane value is not in the expected form, so it cannot be changed safely. Nothing was sent.",
    );
  const keep = new Set(timelines.map((t) => t.id));
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(before)) if (keep.has(k)) next[k] = v;
  for (const t of timelines) if (t.lane !== undefined) next[t.id] = t.lane;
  const same =
    Object.keys(next).length === Object.keys(before).length &&
    Object.entries(next).every(([k, v]) => before[k] === v);
  return same ? {} : { lane: JSON.stringify(next) };
}

function dateFields(start: z.infer<typeof dateSchema> | undefined, end: typeof start): Json {
  const out: Json = {};
  if (start) {
    out.year = start.year;
    for (const k of ["month", "day", "hour", "minute"] as const)
      if (start[k] !== undefined) out[k] = start[k];
  }
  if (end) {
    out.endingYear = end.year;
    const map = {
      month: "endingMonth",
      day: "endingDay",
      hour: "endingHour",
      minute: "endingMinute",
    };
    for (const k of ["month", "day", "hour", "minute"] as const)
      if (end[k] !== undefined) out[map[k]] = end[k];
  }
  return out;
}

export function registerTimelineEventTool(server: McpServer, ctx: WriteContext) {
  if (!enabled(ctx, "wa_upsert_timeline_event")) return;
  server.registerTool(
    "wa_upsert_timeline_event",
    {
      title: "Create or update a timeline event",
      description:
        "Without id: create a dated event (a history entry) on one or more timelines of a world, private by default. " +
        "With id: update only what is given. Dates: the year is text, month/day/hour/minute are whole numbers; an " +
        'end needs its own year (nothing is deduced). lane places the event in a column of a "parallel" timeline. ' +
        "timelines given on update replaces the list. Linked articles and timelines must be in the same world." +
        CONFLICT_NOTE +
        TEXT_NOTE,
      inputSchema: {
        id: id("event").optional().describe("Give it to update an existing event."),
        world_id: id("world").optional().describe("Required to create."),
        title: z.string().trim().min(1).max(300).optional().describe("Required to create."),
        timelines: z
          .array(timelineEntry)
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Required to create: the timelines the event appears on, each with an optional lane.",
          ),
        start: dateSchema.optional().describe("Required to create."),
        end: dateSchema.optional(),
        significance: z.number().int().min(0).max(100).optional(),
        content: z.string().optional().describe("Short text, in Markdown."),
        fullcontent: z.string().optional().describe("Full text, in Markdown."),
        links: eventLinks,
        state: stateSchema,
        append: appendSchema,
        replace_fields: replaceFields,
        raw_bbcode: rawBbcode,
        expected_update_date: expected,
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(ctx, "wa_upsert_timeline_event", async (a, state) => {
      const body: Json = { ...dateFields(a.start, a.end) };
      if (a.title) body.title = a.title;
      if (a.significance !== undefined) body.significance = a.significance;
      if (a.content !== undefined) body.content = a.content;
      if (a.fullcontent !== undefined) body.fullcontent = a.fullcontent;
      if (a.state) body.state = a.state;
      if (a.timelines) body.timelines = a.timelines.map((t) => ({ id: t.id }));
      const linkNames: string[] = [...(a.timelines ? ["timelines"] : [])];
      for (const [k, v] of Object.entries(a.links ?? {})) {
        if (v === undefined) continue;
        body[k] = Array.isArray(v) ? v.map((x) => ({ id: x })) : { id: v };
        linkNames.push(k);
      }

      if (!a.id) {
        if (!a.world_id || !a.title || !a.timelines || !a.start)
          throw new ToolError(
            "To create an event, give world_id, title, timelines and start (with its year). Nothing was sent.",
          );
        if (a.append)
          throw new ToolError("append is for an existing event; give content to create.");
        const lanes = Object.fromEntries(
          a.timelines.filter((t) => t.lane !== undefined).map((t) => [t.id, t.lane]),
        );
        if (Object.keys(lanes).length) body.lane = JSON.stringify(lanes);
        return render(
          ctx,
          await createElement(ctx, state, {
            type: "history",
            body: { ...body, world: { id: a.world_id } },
            strictTemplates: false,
            dryRun: a.dry_run,
            linkFields: linkNames,
            text: textOptions(a.raw_bbcode),
          }),
        );
      }

      refuseCreateOnly(a, ["world_id"]);
      const timelines = a.timelines;
      return render(
        ctx,
        await updateElement(ctx, state, {
          type: "history",
          id: a.id,
          body,
          strictTemplates: false,
          dryRun: a.dry_run,
          expectedUpdateDate: a.expected_update_date,
          linkFields: linkNames,
          text: textOptions(a.raw_bbcode, a.replace_fields, a.append),
          prepare: timelines ? (current) => mergeLane(current.lane, timelines) : undefined,
        }),
      );
    }),
  );
}
