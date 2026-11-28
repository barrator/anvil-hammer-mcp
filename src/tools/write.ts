import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Json } from "../api/client.js";
import { compactElement } from "../output/compact.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../output/untrusted.js";
import { TYPE_NAMES } from "../registry/index.js";
import {
  type WriteContext,
  type WriteOutcome,
  createElement,
  deleteElement,
  listBackups,
  restoreElement,
  updateElement,
} from "../write/service.js";
import { ToolError, handler, serverLine, textResult } from "./context.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const writableTypes = TYPE_NAMES;
const id = (what: string) => z.string().trim().min(1).max(100).describe(`The ${what} ID.`);
const data = z
  .record(z.string(), z.unknown())
  .describe('Fields to send. Link other elements as {"id": "..."} objects.');
const dryRun = z
  .boolean()
  .default(false)
  .describe("Show exactly what would be sent, without writing.");
const expected = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("The updateDate you expect the element to have; the write is refused if it differs.");
const linkValue = z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]);
const links = z
  .record(z.string(), linkValue)
  .optional()
  .describe(
    'Links to other elements of the same world by ID, e.g. {"organization": "<id>"} or {"organizations": ["<id>", "<id>"]}.',
  );

const CONFLICT_NOTE =
  " The element must have been read in this session (wa_get or a list); the write is refused if someone changed it since.";

/** Turn `links` into {"field": {"id"}} / [{"id"}]. Field kinds are checked by the write service, after access checks. */
function linkFields(input: Record<string, string | string[]> | undefined): Json {
  if (!input) return {};
  const out: Json = {};
  for (const [field, value] of Object.entries(input)) {
    out[field] = Array.isArray(value) ? value.map((x) => ({ id: x })) : { id: value };
  }
  return out;
}

function render(ctx: WriteContext, o: WriteOutcome): ReturnType<typeof textResult> {
  const lines: string[] = [];
  const what = `${o.type}${o.id ? ` "${o.id}"` : ""}`;
  if (o.action === "dry_run") {
    lines.push(
      serverLine(`Dry run: nothing was written. This is exactly what would be sent for ${what}:`),
    );
    lines.push(JSON.stringify(o.planned, null, 2));
  } else {
    const verb = o.action.charAt(0).toUpperCase() + o.action.slice(1);
    lines.push(serverLine(`${verb} ${what}.`));
  }
  if (o.defaultsApplied.length)
    lines.push(serverLine(`Safe defaults applied: ${o.defaultsApplied.join(", ")}.`));
  if (o.backup) lines.push(serverLine(`Backup saved before the change: ${o.backup.backupId}.`));
  const c = o.comparison;
  if (c) {
    if (c.stored.length) lines.push(serverLine(`Stored: ${c.stored.join(", ")}.`));
    if (c.ignored.length) {
      lines.push(
        serverLine(`WARNING: World Anvil accepted but did NOT store: ${c.ignored.join(", ")}.`),
      );
    }
    if (c.different.length) {
      lines.push(
        serverLine(`WARNING: stored with a different value than sent: ${c.different.join(", ")}.`),
      );
    }
  }
  for (const w of o.warnings) lines.push(serverLine(`Warning: ${w}`));
  const shown: Json = {};
  if (o.after) {
    const a = compactElement(o.after);
    for (const k of [
      "id",
      "title",
      "url",
      "editURL",
      "state",
      "isDraft",
      "isWip",
      "templateType",
      "updateDate",
    ]) {
      if (k in a) shown[k] = a[k];
    }
  }
  if (o.extra) Object.assign(shown, { details: o.extra });
  if (Object.keys(shown).length) {
    lines.push(serverLine(UNTRUSTED_NOTICE));
    lines.push(wrapUntrusted(`${o.type}:${o.id ?? "new"}`, JSON.stringify(shown, null, 2)));
  }
  return textResult(ctx, lines.join("\n"));
}

export function registerWriteTools(server: McpServer, ctx: WriteContext) {
  server.registerTool(
    "wa_create",
    {
      title: "Create an element",
      description:
        "Create any registered element type (except worlds). New elements are private and draft by default; " +
        'pass "state": "public" only when the user explicitly asks. Referenced elements must be in the same world. ' +
        "Fields unknown to the registry are sent with a warning; the result lists fields World Anvil ignored.",
      inputSchema: { type: z.enum(writableTypes), data, dry_run: dryRun },
      annotations: WRITE,
    },
    handler(ctx, async ({ type, data, dry_run }, state) =>
      render(
        ctx,
        await createElement(ctx, state, {
          type,
          body: data,
          strictTemplates: false,
          dryRun: dry_run,
        }),
      ),
    ),
  );

  server.registerTool(
    "wa_update",
    {
      title: "Update an element",
      description:
        "Update only the given fields of an element. A full backup is saved first and the result is read back." +
        CONFLICT_NOTE,
      inputSchema: {
        type: z.enum(writableTypes),
        id: id("element"),
        data,
        expected_update_date: expected,
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(ctx, async ({ type, id, data, expected_update_date, dry_run }, state) =>
      render(
        ctx,
        await updateElement(ctx, state, {
          type,
          id,
          body: data,
          strictTemplates: false,
          dryRun: dry_run,
          expectedUpdateDate: expected_update_date,
        }),
      ),
    ),
  );

  const articleFields = z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Article and template fields as raw BBCode text. Unknown fields of a probed template are refused; see wa_describe.",
    );

  server.registerTool(
    "wa_create_article",
    {
      title: "Create an article",
      description:
        "Create an article of a template (person, organization, settlement, rank, location, article…). " +
        "Private and draft by default; public only if the user explicitly asks. For probed templates, unknown " +
        "fields are refused before anything is sent; other templates accept them with a warning.",
      inputSchema: {
        world_id: id("world"),
        title: z.string().trim().min(1).max(300),
        template: z.string().trim().min(1).default("article"),
        fields: articleFields,
        links,
        category_id: z.string().trim().min(1).optional(),
        state: z.enum(["private", "public"]).optional(),
        is_draft: z.boolean().optional(),
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(ctx, async (a, state) => {
      const template = a.template.toLowerCase();
      const body: Json = {
        ...(a.fields ?? {}),
        ...linkFields(a.links),
        title: a.title,
        templateType: template,
        world: { id: a.world_id },
      };
      if (a.category_id) body.category = { id: a.category_id };
      if (a.state) body.state = a.state;
      if (a.is_draft !== undefined) body.isDraft = a.is_draft;
      return render(
        ctx,
        await createElement(ctx, state, {
          type: "article",
          body,
          strictTemplates: true,
          dryRun: a.dry_run,
          linkFields: Object.keys(a.links ?? {}),
        }),
      );
    }),
  );

  server.registerTool(
    "wa_update_article",
    {
      title: "Update an article",
      description:
        "Update only the given fields of an article, validated against its template. Backup first, read back after." +
        CONFLICT_NOTE,
      inputSchema: {
        id: id("article"),
        title: z.string().trim().min(1).max(300).optional(),
        fields: articleFields,
        links,
        category_id: z.string().trim().min(1).optional(),
        state: z.enum(["private", "public"]).optional(),
        is_draft: z.boolean().optional(),
        expected_update_date: expected,
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(ctx, async (a, state) => {
      const body: Json = { ...(a.fields ?? {}), ...linkFields(a.links) };
      if (a.title) body.title = a.title;
      if (a.category_id) body.category = { id: a.category_id };
      if (a.state) body.state = a.state;
      if (a.is_draft !== undefined) body.isDraft = a.is_draft;
      return render(
        ctx,
        await updateElement(ctx, state, {
          type: "article",
          id: a.id,
          body,
          strictTemplates: true,
          dryRun: a.dry_run,
          expectedUpdateDate: a.expected_update_date,
          linkFields: Object.keys(a.links ?? {}),
        }),
      );
    }),
  );

  server.registerTool(
    "wa_restore",
    {
      title: "Restore from a backup",
      description:
        "Without backup_id: list an element's backups. With backup_id: put the element back exactly as it was " +
        "(a write: conflict-checked, backed up first, read back). If the element was deleted it is recreated with a " +
        "NEW ID; links to the old ID break. scan_links: true also searches the world's articles for the old ID " +
        "(slow: up to 100 articles, about 1.5 minutes).",
      inputSchema: {
        type: z.enum(writableTypes),
        id: id("element"),
        backup_id: z.string().trim().min(1).optional(),
        scan_links: z.boolean().default(false),
        expected_update_date: expected,
        dry_run: dryRun,
      },
      annotations: WRITE,
    },
    handler(
      ctx,
      async ({ type, id, backup_id, scan_links, expected_update_date, dry_run }, state) => {
        if (!backup_id) {
          const list = listBackups(ctx, type, id).map((b) => ({
            backup_id: b.backupId,
            reason: b.reason,
            taken_at: b.takenAt,
            title: b.element.title,
          }));
          if (list.length === 0) throw new ToolError(`No backups for ${type} "${id}".`);
          return textResult(
            ctx,
            [
              serverLine(
                `${list.length} backup(s) for ${type} "${id}", newest first. ${UNTRUSTED_NOTICE}`,
              ),
              wrapUntrusted(`backups:${type}:${id}`, JSON.stringify(list, null, 2)),
            ].join("\n"),
          );
        }
        return render(
          ctx,
          await restoreElement(ctx, state, {
            type,
            id,
            backupId: backup_id,
            dryRun: dry_run,
            scanLinks: scan_links,
            expectedUpdateDate: expected_update_date,
          }),
        );
      },
    ),
  );

  if (ctx.enableDelete) {
    server.registerTool(
      "wa_delete",
      {
        title: "Delete an element",
        description:
          "Delete an element of a full_edit world. A full backup is saved first (restore recreates it with a new ID)." +
          CONFLICT_NOTE,
        inputSchema: {
          type: z.enum(writableTypes),
          id: id("element"),
          expected_update_date: expected,
          dry_run: dryRun,
        },
        annotations: DESTRUCTIVE,
      },
      handler(ctx, async ({ type, id, expected_update_date, dry_run }, state) =>
        render(
          ctx,
          await deleteElement(ctx, state, {
            type,
            id,
            expectedUpdateDate: expected_update_date,
            dryRun: dry_run,
          }),
        ),
      ),
    );
  }
}
