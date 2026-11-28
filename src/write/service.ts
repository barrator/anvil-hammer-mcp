/**
 * Safe writes (stage B). Every path follows the same order:
 *   read current state → resolve world → check access level → validate →
 *   check references → check conflicts → (dry run stops here) → back up →
 *   write → read back and compare.
 */
import { type Json, WorldAnvilApiError } from "../api/client.js";
import type { AccessLevel } from "../config/access.js";
import { RESPONSE_FLAGS } from "../output/compact.js";
import { getType } from "../registry/index.js";
import type { TypeDef } from "../registry/types.js";
import { refId } from "../resolver.js";
import { type SessionState, normalizeUpdateDate } from "../session.js";
import { type ToolContext, ToolError, notFound } from "../tools/context.js";
import { type Backup, BackupError } from "./backups.js";
import { type TextOptions, mentionTargetType, newMentions, prepareText } from "./text.js";
import {
  type Comparison,
  ValidationError,
  applyCreateDefaults,
  compareReadBack,
  knownFields,
  outgoingLinks,
  referencesIn,
  restoreBody,
  sameValue,
  validateFields,
} from "./fields.js";

export interface WriteContext extends ToolContext {
  backups: import("./backups.js").BackupStore;
  enableDelete: boolean;
}

export interface PlannedCall {
  method: "PUT" | "PATCH" | "DELETE";
  route: string;
  query: Record<string, string>;
  body?: Json;
}

export interface WriteOutcome {
  action: "created" | "updated" | "restored" | "recreated" | "deleted" | "dry_run";
  type: string;
  id?: string;
  worldId: string;
  planned: PlannedCall;
  warnings: string[];
  defaultsApplied: string[];
  comparison?: Comparison;
  /** Read-back element (untrusted world content). */
  after?: Json;
  backup?: Backup;
  extra?: Json;
}

const WRITE_LEVELS: AccessLevel[] = ["full_edit", "edit_only"];

/** Not found for blocked worlds; explicit refusal for read_only and others. */
function assertCanWrite(
  ctx: WriteContext,
  worldId: string,
  type: string,
  id: string,
  verb: "write" | "delete",
) {
  const level = ctx.access.levelFor(worldId);
  if (level === "blocked") throw notFound(type, id);
  if (verb === "delete") {
    if (level !== "full_edit") {
      throw new ToolError(
        `Refused: deleting requires a full_edit world; this element's world is ${level}.`,
      );
    }
    return;
  }
  if (!WRITE_LEVELS.includes(level)) {
    throw new ToolError(
      `Refused: this element's world is ${level}; writes need full_edit or edit_only.`,
    );
  }
}

async function readCurrent(ctx: WriteContext, def: TypeDef, id: string): Promise<Json | undefined> {
  try {
    return await ctx.client.request<Json>("GET", def.path, {
      id,
      granularity: def.backupGranularity,
    });
  } catch (err) {
    if (err instanceof WorldAnvilApiError && err.kind === "not_found") return undefined;
    throw err;
  }
}

async function worldOf(
  ctx: WriteContext,
  state: SessionState,
  def: TypeDef,
  id: string,
  element: Json,
): Promise<string> {
  const world = await ctx.resolver.resolve(state, def.name, id, {
    element,
    granularity: def.backupGranularity,
  });
  if (!world) {
    throw new ToolError(
      `Refused: could not determine which world ${def.name} "${id}" belongs to, so access cannot be checked.`,
    );
  }
  return world;
}

/** Every referenced element must belong to the target world. */
async function checkReferences(
  ctx: WriteContext,
  state: SessionState,
  def: TypeDef,
  body: Json,
  worldId: string,
  template?: string,
  current?: Json,
) {
  // Mentions added to text fields must point to the same world (each target read once per session).
  for (const m of newMentions(def, template, body, current)) {
    const type = mentionTargetType(m.type);
    if (!type) {
      throw new ToolError(
        `Refused: the mention of ${m.type} "${m.id}" in "${m.field}" cannot be checked against the world (unknown type). Nothing was sent.`,
      );
    }
    const w = await ctx.resolver.resolve(state, type, m.id);
    if (w !== worldId) {
      throw new ToolError(
        `Refused: "${m.field}" mentions ${m.type} "${m.id}", which is not in the same world (or not accessible). Nothing was sent.`,
      );
    }
  }
  for (const ref of referencesIn(def, body, template)) {
    if (ref.unsupported) {
      throw new ToolError(
        `Refused: field "${ref.field}" links to "${ref.id}", but ${ref.unsupported}. Nothing was sent.`,
      );
    }
    const w = ref.type ? await ctx.resolver.resolve(state, ref.type, ref.id) : undefined;
    if (w !== worldId) {
      throw new ToolError(
        `Refused: field "${ref.field}" links to ${ref.type} "${ref.id}", which is not in the same world (or not accessible). Nothing was sent.`,
      );
    }
  }
}

/**
 * Refuse if the element changed since this session last read it (or since
 * expected_update_date). Elements without an updateDate (seen live on
 * subscriber groups) are compared by content instead: every field seen at the
 * last read must still have the same value.
 */
function checkConflict(
  state: SessionState,
  type: string,
  id: string,
  current: Json,
  expected?: string,
) {
  const now = normalizeUpdateDate(current.updateDate);
  if (now === undefined) {
    if (expected !== undefined) {
      throw new ToolError(
        `Refused: ${type} "${id}" has no updateDate, so expected_update_date cannot be checked. Read it again with wa_get, then retry without it.`,
      );
    }
    const seen = state.lastContent(type, id);
    if (!seen) {
      throw new ToolError(
        `Refused: ${type} "${id}" has not been read in this session. Read it first with wa_get, then retry.`,
      );
    }
    const changed = Object.keys(seen).filter(
      (k) => !RESPONSE_FLAGS.has(k) && k in current && !sameValue(seen[k], current[k]),
    );
    if (changed.length) {
      throw new ToolError(
        `Refused: ${type} "${id}" was changed by someone else since you last read it (changed: ${changed.join(", ")}). ` +
          "Read it again with wa_get, check the changes, then retry.",
      );
    }
    return;
  }
  const reference =
    expected !== undefined
      ? normalizeUpdateDate(expected)
      : state.lastUpdateDate(type, id)?.updateDate;
  if (reference === undefined) {
    throw new ToolError(
      `Refused: ${type} "${id}" has not been read in this session. Read it first with wa_get, then retry.`,
    );
  }
  if (now !== reference) {
    throw new ToolError(
      `Refused: ${type} "${id}" was changed by someone else since you last read it ` +
        `(last read: ${reference}; now: ${now}). Read it again with wa_get, check the changes, then retry.`,
    );
  }
}

function takeBackup(
  ctx: WriteContext,
  def: TypeDef,
  id: string,
  worldId: string,
  reason: Backup["reason"],
  element: Json,
): Backup {
  try {
    return ctx.backups.save(
      { type: def.name, id, worldId, reason, granularity: def.backupGranularity },
      element,
    );
  } catch (err) {
    const msg = err instanceof BackupError ? err.message : String(err);
    throw new ToolError(`Refused: ${msg} Nothing was written.`);
  }
}

async function readBack(
  ctx: WriteContext,
  state: SessionState,
  def: TypeDef,
  id: string,
  worldId: string,
): Promise<Json> {
  const after = await ctx.client.request<Json>("GET", def.path, {
    id,
    granularity: def.backupGranularity,
  });
  state.rememberRead(def.name, id, after);
  state.worlds.set(`${def.name}:${id}`, worldId);
  return after;
}

/** Fields passed through `links` must be link fields (checked after access, so nothing leaks). */
function checkLinkFields(def: TypeDef, template: string | undefined, names: string[] | undefined) {
  if (!names?.length) return;
  const known = knownFields(def, template);
  for (const n of names) {
    const f = known[n];
    if (f && (f.kind === "ref" || f.kind === "refs") && f.writable !== false) continue;
    const linkable = Object.entries(known)
      .filter(([, d]) => (d.kind === "ref" || d.kind === "refs") && d.writable !== false)
      .map(([k]) => k)
      .sort();
    throw new ToolError(
      `"${n}" is not a link field for ${template ?? def.name}. Nothing was sent. Link fields: ${linkable.join(", ")}.`,
    );
  }
}

function asToolError(err: unknown): never {
  if (err instanceof ValidationError) throw new ToolError(err.message);
  throw err;
}

// ---------- create ----------

export interface CreateInput {
  type: string;
  body: Json;
  /** Article tools validate template fields strictly. */
  strictTemplates: boolean;
  dryRun: boolean;
  /** Restore of a deleted element: keep the backup's own state instead of defaults. */
  noDefaults?: boolean;
  /** Fields given through `links`: must be link fields of the type/template. */
  linkFields?: string[];
  /** Text fields: Markdown from the tools, raw BBCode from internal callers. Default "bbcode". */
  text?: Omit<TextOptions, "isRestore">;
}

export async function createElement(
  ctx: WriteContext,
  state: SessionState,
  input: CreateInput,
): Promise<WriteOutcome> {
  const def = getType(input.type);
  if (def.name === "world")
    throw new ToolError("Refused: worlds cannot be created through this server.");
  if (!def.verbs.includes("create")) throw new ToolError(`Refused: ${def.name} cannot be created.`);

  const template =
    typeof input.body.templateType === "string" ? input.body.templateType : undefined;
  let validated;
  try {
    validated = validateFields(def, input.body, {
      template,
      strictTemplates: input.strictTemplates,
    });
  } catch (err) {
    asToolError(err);
  }
  const text = prepareText(def, template, validated.body, undefined, {
    textFormat: input.text?.textFormat ?? "bbcode",
  });
  let body = text.body;
  validated.warnings.push(...text.warnings);

  // Which world? Its own reference, else a parent in the body.
  let worldId = refId(body.world);
  if (!worldId) {
    for (const p of def.parents) {
      const pid = refId(body[p.field]);
      if (!pid) continue;
      worldId = await ctx.resolver.resolve(state, p.type, pid);
      if (worldId) break;
    }
  }
  if (!worldId) {
    throw new ToolError(
      `Refused: say which world the new ${def.name} belongs to ("world": {"id": ...}). Nothing was sent.`,
    );
  }
  assertCanWrite(ctx, worldId, "world", worldId, "write");
  checkLinkFields(def, template, input.linkFields);
  if ("world" in def.fields) body = { ...body, world: { id: worldId } };

  await checkReferences(ctx, state, def, body, worldId, template);

  const withDefaults = input.noDefaults ? { body, applied: [] } : applyCreateDefaults(def, body);
  body = withDefaults.body;
  const planned: PlannedCall = { method: "PUT", route: def.path, query: {}, body };
  const base = {
    type: def.name,
    worldId,
    planned,
    warnings: validated.warnings,
    defaultsApplied: withDefaults.applied,
  };
  if (input.dryRun) return { action: "dry_run", ...base };

  const created = await ctx.client.request<Json>("PUT", def.path, {}, body);
  const id =
    typeof created.id === "string"
      ? created.id
      : typeof created.id === "number"
        ? String(created.id)
        : undefined;
  if (!id)
    throw new ToolError(
      "World Anvil did not return the new element's ID; check the world before retrying.",
    );
  const after = await readBack(ctx, state, def, id, worldId);
  return { action: "created", ...base, id, after, comparison: compareReadBack(body, after) };
}

// ---------- update ----------

export interface UpdateInput {
  type: string;
  id: string;
  body: Json;
  strictTemplates: boolean;
  dryRun: boolean;
  expectedUpdateDate?: string;
  /** Internal: restore uses the update path with its own backup reason. */
  reason?: "update" | "restore";
  linkFields?: string[];
  /** Text fields: format, append, replace confirmation. Default: raw BBCode, no append. */
  text?: Omit<TextOptions, "isRestore">;
}

export async function updateElement(
  ctx: WriteContext,
  state: SessionState,
  input: UpdateInput,
): Promise<WriteOutcome> {
  const def = getType(input.type);
  if (!def.verbs.includes("update")) throw new ToolError(`Refused: ${def.name} cannot be updated.`);

  const current = await readCurrent(ctx, def, input.id);
  if (!current) throw notFound(def.name, input.id);
  const worldId =
    def.name === "world" ? input.id : await worldOf(ctx, state, def, input.id, current);
  assertCanWrite(ctx, worldId, def.name, input.id, "write");

  const template = typeof current.templateType === "string" ? current.templateType : undefined;
  checkLinkFields(def, template, input.linkFields);
  let validated;
  try {
    validated = validateFields(def, input.body, {
      template,
      strictTemplates: input.strictTemplates,
    });
  } catch (err) {
    asToolError(err);
  }
  const text = prepareText(def, template, { ...validated.body }, current, {
    textFormat: input.text?.textFormat ?? "bbcode",
    replaceFields: input.text?.replaceFields,
    append: input.text?.append,
    isRestore: input.reason === "restore",
  });
  const body = text.body;
  validated.warnings.push(...text.warnings);

  if ("world" in body) {
    const target = refId(body.world);
    if (def.name === "world" || target !== worldId) {
      throw new ToolError(
        "Refused: an element cannot be moved to another world. Nothing was sent.",
      );
    }
    delete body.world;
  }
  if (
    "templateType" in body &&
    String(body.templateType).toLowerCase() !== String(template ?? "").toLowerCase()
  ) {
    throw new ToolError(
      "Refused: changing an article's template is not supported. Nothing was sent.",
    );
  }
  if (Object.keys(body).length === 0) throw new ToolError("Nothing to update: no field to send.");

  checkConflict(state, def.name, input.id, current, input.expectedUpdateDate);
  await checkReferences(ctx, state, def, body, worldId, template, current);

  const planned: PlannedCall = { method: "PATCH", route: def.path, query: { id: input.id }, body };
  const base = {
    type: def.name,
    id: input.id,
    worldId,
    planned,
    warnings: validated.warnings,
    defaultsApplied: [],
  };
  if (input.dryRun) return { action: "dry_run", ...base };

  const backup = takeBackup(ctx, def, input.id, worldId, input.reason ?? "update", current);
  await ctx.client.request<Json>("PATCH", def.path, { id: input.id }, body);
  const after = await readBack(ctx, state, def, input.id, worldId);
  for (const [k, prefix] of Object.entries(text.appendedPrefixes)) {
    const stored = typeof after[k] === "string" ? (after[k] as string) : "";
    if (!stored.startsWith(prefix)) {
      validated.warnings.push(
        `WARNING: the existing text of "${k}" was not kept intact by World Anvil; check it and restore from the backup if needed.`,
      );
    }
  }
  return {
    action: input.reason === "restore" ? "restored" : "updated",
    ...base,
    backup,
    after,
    comparison: compareReadBack(body, after, current),
  };
}

// ---------- delete ----------

export async function deleteElement(
  ctx: WriteContext,
  state: SessionState,
  input: { type: string; id: string; expectedUpdateDate?: string; dryRun: boolean },
): Promise<WriteOutcome> {
  const def = getType(input.type);
  if (!ctx.enableDelete)
    throw new ToolError("Refused: delete is disabled in this server's configuration.");
  if (def.name === "world")
    throw new ToolError("Refused: worlds cannot be deleted through this server.");
  if (!def.verbs.includes("delete")) throw new ToolError(`Refused: ${def.name} cannot be deleted.`);

  const current = await readCurrent(ctx, def, input.id);
  if (!current) throw notFound(def.name, input.id);
  const worldId = await worldOf(ctx, state, def, input.id, current);
  assertCanWrite(ctx, worldId, def.name, input.id, "delete");
  checkConflict(state, def.name, input.id, current, input.expectedUpdateDate);

  const planned: PlannedCall = { method: "DELETE", route: def.path, query: { id: input.id } };
  const base = {
    type: def.name,
    id: input.id,
    worldId,
    planned,
    warnings: [],
    defaultsApplied: [],
  };
  if (input.dryRun) return { action: "dry_run", ...base };

  const backup = takeBackup(ctx, def, input.id, worldId, "delete", current);
  await ctx.client.request<Json>("DELETE", def.path, { id: input.id });
  state.forget(def.name, input.id);
  return { action: "deleted", ...base, backup };
}

// ---------- restore ----------

/** Cap for scan_links: at ~750 ms per call, 100 articles take about 1.5 minutes. */
export const SCAN_LINKS_MAX_ARTICLES = 100;

export async function restoreElement(
  ctx: WriteContext,
  state: SessionState,
  input: {
    type: string;
    id: string;
    backupId: string;
    dryRun: boolean;
    scanLinks: boolean;
    expectedUpdateDate?: string;
    /** Explicit request to make the element public again when the backup was public. */
    restorePublic?: boolean;
  },
): Promise<WriteOutcome> {
  const def = getType(input.type);
  let backup: Backup | undefined;
  try {
    backup = ctx.backups.get(def.name, input.id, input.backupId);
  } catch (err) {
    throw new ToolError(err instanceof Error ? err.message : String(err));
  }
  if (!backup || !ctx.access.canRead(backup.worldId)) {
    throw new ToolError(
      `No backup "${input.backupId}" for ${def.name} "${input.id}". Call wa_restore without backup_id to list them.`,
    );
  }
  assertCanWrite(ctx, backup.worldId, def.name, input.id, "write");

  const notes: string[] = [];
  /** Nothing becomes public through a restore unless the call asks for it explicitly. */
  const keepPrivate = (body: Json, publicNow: boolean) => {
    if (body.state === "public" && !publicNow && !input.restorePublic) {
      body.state = "private";
      notes.push(
        "The backup was public; it was restored as PRIVATE. Pass restore_public: true only if the user asks to make it public again.",
      );
    }
  };
  const noteImages = (images: string[]) => {
    if (images.length) {
      notes.push(
        `Image references are not restored (they cannot be checked yet): ${images.join(", ")}.`,
      );
    }
  };

  const current = await readCurrent(ctx, def, input.id);
  if (current) {
    const { body, skipped, images } = restoreBody(def, backup.element, current);
    keepPrivate(body, current.state === "public");
    noteImages(images);
    if (Object.keys(body).length === 0) {
      throw new ToolError(
        `Nothing to restore: ${def.name} "${input.id}" already matches backup "${input.backupId}".`,
      );
    }
    const out = await updateElement(ctx, state, {
      type: def.name,
      id: input.id,
      body,
      strictTemplates: false,
      dryRun: input.dryRun,
      expectedUpdateDate: input.expectedUpdateDate,
      reason: "restore",
    });
    out.warnings.push(...notes);
    if (skipped.length) {
      out.warnings.push(`Not restored (unknown to the registry): ${skipped.join(", ")}.`);
    }
    return { ...out, extra: { restoredFrom: input.backupId } };
  }

  // The element no longer exists: recreate it. World Anvil gives it a new ID.
  const { body, skipped, images } = restoreBody(def, backup.element, undefined);
  keepPrivate(body, false);
  noteImages(images);
  body.world = { id: backup.worldId };
  if (def.name === "article" && typeof backup.element.templateType === "string") {
    body.templateType = backup.element.templateType;
  }
  const out = await createElement(ctx, state, {
    type: def.name,
    body,
    strictTemplates: false,
    dryRun: input.dryRun,
    noDefaults: true,
  });
  out.warnings.push(...notes);
  if (skipped.length) {
    out.warnings.push(`Not restored (unknown to the registry): ${skipped.join(", ")}.`);
  }

  const extra: Json = {
    restoredFrom: input.backupId,
    oldId: input.id,
    outgoingLinks: outgoingLinks(def, backup.element),
    note: "The element was recreated with a NEW ID. Links elsewhere that pointed to the old ID are broken and must be fixed by hand.",
  };
  if (input.scanLinks && !input.dryRun) {
    extra.incomingLinks = await scanIncomingLinks(ctx, backup.worldId, input.id);
  }
  return { ...out, action: input.dryRun ? "dry_run" : "recreated", extra };
}

/** Slow: reads up to SCAN_LINKS_MAX_ARTICLES articles of the world looking for the old ID. */
async function scanIncomingLinks(ctx: WriteContext, worldId: string, oldId: string): Promise<Json> {
  const { items } = await ctx.client.listAll("world/articles", worldId);
  const ids = items.map((a) => a.id).filter((x): x is string => typeof x === "string");
  const scanned = ids.slice(0, SCAN_LINKS_MAX_ARTICLES);
  const found: Json[] = [];
  for (const id of scanned) {
    const a = await ctx.client.request<Json>("GET", "article", { id, granularity: "2" });
    if (JSON.stringify(a).includes(oldId)) found.push({ id, title: a.title });
  }
  return {
    articlesInWorld: ids.length,
    articlesScanned: scanned.length,
    complete: scanned.length === ids.length,
    articlesMentioningOldId: found,
  };
}

/** Backups of an element the caller may see (never those of a blocked world). */
export function listBackups(ctx: WriteContext, type: string, id: string): Backup[] {
  const def = getType(type);
  try {
    return ctx.backups.list(def.name, id).filter((b) => ctx.access.canRead(b.worldId));
  } catch (err) {
    throw new ToolError(err instanceof Error ? err.message : String(err));
  }
}
