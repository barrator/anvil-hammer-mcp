/**
 * Field validation, reference extraction, defaults and read-back comparison
 * for writes. Pure functions: no network.
 */
import type { Json } from "../api/client.js";
import { REGISTRY } from "../registry/index.js";
import type { FieldDef, TemplateDef, TypeDef } from "../registry/types.js";

export class ValidationError extends Error {
  override name = "ValidationError";
}

export const UNPROBED_TEMPLATE_WARNING =
  "template not probed yet, fields unverified, check the read-back";

/** Article templates that reject unknown fields: the probed ones, plus the plain article template. */
export function templateFor(
  def: TypeDef,
  template: string | undefined,
): { name: string; def?: TemplateDef } | undefined {
  if (def.name !== "article") return undefined;
  const name = (template ?? "article").toLowerCase();
  return { name, def: def.templates?.[name] };
}

export function isStrictTemplate(t: { name: string; def?: TemplateDef }): boolean {
  return t.name === "article" || t.def?.probed === true;
}

/** Every field the registry knows for this type (and article template). */
export function knownFields(def: TypeDef, template?: string): Record<string, FieldDef> {
  const t = templateFor(def, template);
  return { ...def.fields, ...(t?.def?.fields ?? {}) };
}

/** Is `name` a BBCode text field for this type and template? */
export function isTextField(def: TypeDef, template: string | undefined, name: string): boolean {
  return knownFields(def, template)[name]?.bbcode === true;
}

export interface ValidationResult {
  /** Body to send: computed fields removed. */
  body: Json;
  warnings: string[];
}

/**
 * Check field names before any call.
 * - Computed fields (writable: false) are dropped with a warning.
 * - Article tools (`strictTemplates`): unknown fields are refused for the plain
 *   article template and probed templates; accepted with a warning otherwise.
 * - Generic tools: unknown fields are accepted with a warning.
 */
export function validateFields(
  def: TypeDef,
  body: Json,
  opts: { template?: string; strictTemplates: boolean },
): ValidationResult {
  const known = knownFields(def, opts.template);
  const t = templateFor(def, opts.template);
  const out: Json = {};
  const warnings: string[] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    const f = known[k];
    if (f?.writable === false) {
      warnings.push(`Field "${k}" is computed by World Anvil and was not sent.`);
      continue;
    }
    if (!f) unknown.push(k);
    out[k] = v;
  }
  if (unknown.length) {
    if (t && opts.strictTemplates && isStrictTemplate(t)) {
      const allowed = Object.entries(known)
        .filter(([, f]) => f.writable !== false)
        .map(([k]) => k)
        .sort();
      throw new ValidationError(
        `Unknown field(s) for article template "${t.name}": ${unknown.join(", ")}. Nothing was sent. ` +
          `Known fields: ${allowed.join(", ")}.`,
      );
    }
    const why =
      t && !isStrictTemplate(t)
        ? UNPROBED_TEMPLATE_WARNING
        : "unknown to the registry, check the read-back";
    warnings.push(`Field(s) ${unknown.join(", ")}: ${why}.`);
  }
  return { body: out, warnings };
}

/** {id} or [{id}, ...] → list of ids; undefined if the value is not a reference. Numeric ids (images) become text. */
export function refIds(value: unknown): string[] | undefined {
  const one = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const id = (v as Json).id;
    if (typeof id === "string" && id) return id;
    if (typeof id === "number" && id !== -1) return String(id);
    return undefined;
  };
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const ids = value.map(one);
    return ids.every((x): x is string => x !== undefined) ? ids : undefined;
  }
  const id = one(value);
  return id ? [id] : undefined;
}

export interface RefToCheck {
  field: string;
  id: string;
  /** Registered type to resolve, or a reason the reference cannot be checked. */
  type?: string;
  unsupported?: string;
}

/**
 * References in a body that must be checked before sending. `world` is handled
 * separately. World elements (images included) must be in the target world;
 * account and catalog elements (block templates, RPG systems, marker types)
 * must be readable. Types without a read route (eras) cannot be checked.
 */
export function referencesIn(def: TypeDef, body: Json, template?: string): RefToCheck[] {
  const known = knownFields(def, template);
  const out: RefToCheck[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (field === "world") continue;
    const ids = refIds(value);
    if (!ids) continue;
    const f = known[field];
    const refType = f?.refType;
    for (const id of ids) {
      if (refType === "internal") continue; // internal IDs belong to no world
      const target = refType ? REGISTRY[refType] : undefined;
      if (target && !target.verbs.includes("get"))
        out.push({
          field,
          id,
          unsupported: `${refType} references cannot be checked (World Anvil has no route to read them)`,
        });
      else if (target) out.push({ field, id, type: refType });
      else if (refType)
        out.push({
          field,
          id,
          unsupported: `references to ${refType} elements cannot be checked against the world yet`,
        });
      else
        out.push({ field, id, unsupported: "the registry does not know what this field links to" });
    }
  }
  return out;
}

/** Safe defaults for create: private and draft where the type has those fields. Explicit values win. */
export function applyCreateDefaults(def: TypeDef, body: Json): { body: Json; applied: string[] } {
  const out = { ...body };
  const applied: string[] = [];
  if ("state" in def.fields && out.state === undefined) {
    out.state = "private";
    applied.push("state=private");
  }
  if ("isDraft" in def.fields && out.isDraft === undefined) {
    out.isDraft = true;
    applied.push("isDraft=true");
  }
  for (const [k, v] of Object.entries(def.createDefaults ?? {})) {
    if (out[k] !== undefined) continue;
    out[k] = v;
    applied.push(`${k}=${JSON.stringify(v)}`);
  }
  return { body: out, applied };
}

// ---------- Read-back comparison ----------

/**
 * World Anvil returns `{"id": -1}` for an unset reference (seen live on
 * `cover`). It is a placeholder, not a link: treat it as empty.
 */
export function isPlaceholderRef(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const id = (v as Json).id;
  return id === -1 || id === "-1";
}

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  isPlaceholderRef(v);

/**
 * Comparable form of a value: references → sorted ids, World Anvil dates →
 * date string, "true"/"false" → booleans, numeric strings → numbers, CRLF → LF.
 * Empty values (null, "", []) are all null.
 */
function normalize(v: unknown): unknown {
  if (isEmpty(v)) return null;
  const ids = refIds(v);
  if (ids) return [...ids].sort().join(",");
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.replace(/\r\n/g, "\n");
    if (s === "true") return true;
    if (s === "false") return false;
    return /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : s;
  }
  if (v && typeof v === "object" && typeof (v as Json).date === "string") return (v as Json).date;
  return JSON.stringify(v);
}

/** Booleans may come back as 1/0 and false may come back empty. */
function asBool(v: unknown): boolean | undefined {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null) return false;
  return undefined;
}

export function sameValue(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (typeof na === "boolean" || typeof nb === "boolean") {
    const ba = asBool(na);
    return ba !== undefined && ba === asBool(nb);
  }
  return false;
}

export interface Comparison {
  stored: string[];
  /** Sent but not stored: absent, empty, or unchanged from before. */
  ignored: string[];
  /** Stored with a different value than sent. */
  different: string[];
}

export function compareReadBack(sent: Json, after: Json, before?: Json): Comparison {
  const r: Comparison = { stored: [], ignored: [], different: [] };
  for (const [k, v] of Object.entries(sent)) {
    const got = after[k];
    if (sameValue(v, got)) r.stored.push(k);
    else if (isEmpty(got) || (before !== undefined && sameValue(before[k], got))) r.ignored.push(k);
    else r.different.push(k);
  }
  return r;
}

// ---------- Restore ----------

/** The id of a reference as World Anvil returned it (text, or a number for images). */
function rawId(v: unknown): string | number | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const id = (v as Json).id;
  return (typeof id === "string" && id) || (typeof id === "number" && id !== -1) ? id : undefined;
}

/** Value to send for a field taken from a backup. */
function toWrite(value: unknown, f: FieldDef): unknown {
  if (f.kind === "ref") {
    const id = rawId(Array.isArray(value) ? value[0] : value);
    return id === undefined ? null : { id };
  }
  if (f.kind === "refs") {
    const list = Array.isArray(value) ? value : [value];
    return list
      .map(rawId)
      .filter((x) => x !== undefined)
      .map((id) => ({ id }));
  }
  return value;
}

function emptyFor(f: FieldDef): unknown {
  if (f.kind === "ref") return null;
  if (f.kind === "refs" || f.kind === "list") return [];
  if (f.kind === "string") return "";
  return undefined; // booleans/numbers/dates: leave as they are
}

/**
 * Body that puts an element back as it was in a backup: every known writable
 * field that differs from the current element, including clearing fields that
 * were empty in the backup. Dates are left alone (World Anvil manages them).
 * `images` names the image references the body sets: the caller checks that
 * each image is readable and in the same world, and drops it otherwise.
 */
export function restoreBody(
  def: TypeDef,
  backup: Json,
  current: Json | undefined,
): { body: Json; skipped: string[]; images: string[] } {
  const template = typeof backup.templateType === "string" ? backup.templateType : undefined;
  const known = knownFields(def, template);
  const body: Json = {};
  const images: string[] = [];
  for (const [k, f] of Object.entries(known)) {
    if (f.writable === false || f.kind === "date" || k === "world") continue;
    const b = backup[k];
    const c = current?.[k];
    let value: unknown;
    if (isEmpty(b)) {
      if (current === undefined || isEmpty(c)) continue;
      value = emptyFor(f);
      if (value === undefined) continue;
    } else {
      value = toWrite(b, f);
    }
    if (current !== undefined && sameValue(value, c)) continue;
    body[k] = value;
    if (f.refType === "image" && refIds(value)) images.push(k);
  }
  const skipped = Object.keys(backup).filter((k) => !(k in known) && k !== "success");
  return { body, skipped, images };
}

/** Outgoing links of an element (fields holding references), for restore reports. */
export function outgoingLinks(def: TypeDef, element: Json): { field: string; ids: string[] }[] {
  const template = typeof element.templateType === "string" ? element.templateType : undefined;
  const known = knownFields(def, template);
  const out: { field: string; ids: string[] }[] = [];
  for (const [k, v] of Object.entries(element)) {
    if (k === "world" || known[k]?.writable === false) continue;
    const ids = refIds(v);
    if (ids) out.push({ field: k, ids });
  }
  return out;
}
