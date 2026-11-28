/** Small builders shared by the registry files. Everything they make starts `unverified`. */
import type { FieldDef, FieldKind, ParentLink } from "./types.js";

/** Field taken from the official spec, not yet observed live. */
export const spec = (kind: FieldKind, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  status: "unverified",
  source: "spec",
  ...extra,
});

/** Field known from project notes (CLAUDE.md quirks or the owner's reads), not yet observed by the harness. */
export const notes = (kind: FieldKind, note: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  status: "unverified",
  source: "notes",
  note,
  ...extra,
});

/** Field name seen in a live response (stage B write run) whose kind is not confirmed by a value. */
export const probe = (kind: FieldKind, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  status: "unverified",
  source: "probe",
  kindConfirmed: false,
  ...extra,
});

export const bb = (extra: Partial<FieldDef> = {}) => spec("string", { bbcode: true, ...extra });

/** Computed by World Anvil: never sent. */
export const ro = (kind: FieldKind, extra: Partial<FieldDef> = {}) =>
  spec(kind, { writable: false, ...extra });

export const ref = (refType: string | undefined, extra: Partial<FieldDef> = {}) =>
  spec("ref", { ...(refType ? { refType } : {}), ...extra });

export const refs = (refType: string | undefined, extra: Partial<FieldDef> = {}) =>
  spec("refs", { ...(refType ? { refType } : {}), ...extra });

/** Fields every element shares (spec "Ref" schemas). */
export const COMMON: Record<string, FieldDef> = {
  id: spec("string", { writable: false }),
  title: spec("string"),
  slug: spec("string", { writable: false }),
  state: spec("string", { note: "public or private" }),
  isWip: spec("boolean"),
  isDraft: spec("boolean"),
  entityClass: spec("string", { writable: false }),
  icon: spec("string"),
  url: spec("string", { writable: false }),
  subscribergroups: spec("refs", { refType: "subscribergroup" }),
  folderId: spec("string"),
  tags: spec("string", { note: "comma-separated" }),
  updateDate: spec("date", { writable: false }),
  creationDate: spec("date", { writable: false }),
  isEditable: spec("boolean", { writable: false }),
};

/** Common fields minus some that a type does not really have (observed live). */
export const without = (
  fields: Record<string, FieldDef>,
  ...names: string[]
): Record<string, FieldDef> =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => !names.includes(k)));

export const worldRef = (granularity: string) =>
  ({ field: "world", granularity, status: "unverified" }) as const;

export const parent = (field: string, type: string, granularity: string): ParentLink => ({
  field,
  type,
  granularity,
  status: "unverified",
});
