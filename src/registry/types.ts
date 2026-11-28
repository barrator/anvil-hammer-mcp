/**
 * Shape of the type registry (docs/architecture.md §3). The registry is the
 * single place that knows World Anvil routes, fields and quirks; tools are
 * generic and read from it.
 */

export type Verb = "get" | "list" | "create" | "update" | "delete";

/**
 * `verified`: observed in a real World Anvil response by the live-test harness.
 * `unverified`: taken from the official spec or from notes; not yet observed.
 * Everything starts unverified and is promoted after a live run confirms it.
 */
export type FieldStatus = "verified" | "unverified";

/** Where an unverified entry comes from. */
/** spec: official OpenAPI spec; notes: CLAUDE.md quirks; probe: field name seen by the template probe. */
export type FieldSource = "spec" | "notes" | "probe";

export type FieldKind =
  | "string"
  | "boolean"
  | "integer"
  | "date"
  | "ref" // linked element, sent and returned as {id, ...}
  | "refs" // list of linked elements
  | "list"
  | "object";

export interface FieldDef {
  kind: FieldKind;
  status: FieldStatus;
  source: FieldSource;
  /** Text stored as BBCode (to be converted and protected in later stages). */
  bbcode?: boolean;
  /** Required when creating the element. */
  requiredOnCreate?: boolean;
  /**
   * For ref/refs: the type of the linked element, when known. A registered
   * type name (e.g. "article"), "image" (reference to an uploaded image), or
   * "internal" (a World Anvil internal ID such as an organization type, which
   * belongs to no world).
   */
  refType?: string;
  /**
   * False when the kind is inferred from the field name or the spec and has
   * not been confirmed by a value seen live. Absent means confirmed or not applicable.
   */
  kindConfirmed?: boolean;
  /** Computed by World Anvil; never sent on create, update or restore. */
  writable?: false;
  /**
   * Never shown by the read tools (kept in backups): rendered duplicates such as
   * `parsedContent`, and secrets or personal data such as a profile's tokens.
   */
  hidden?: true;
  note?: string;
}

/** How to find the world an element belongs to. */
export interface WorldLink {
  /** Field holding a reference to the world, e.g. "world". */
  field: string;
  /** Lowest granularity at which that field is expected in a GET response. */
  granularity: string;
  status: FieldStatus;
}

/** Fallback when the world field is absent: follow a parent element instead. */
export interface ParentLink {
  field: string;
  type: string;
  /** Lowest granularity at which that field is expected in a GET response. */
  granularity: string;
  status: FieldStatus;
}

export interface ListRoute {
  path: string;
  /**
   * Type whose id goes in ?id=. "user": the token owner's own user id (filled in
   * by the server). "none": a shared list with no parent (catalogs).
   */
  parentType: string;
}

export interface TemplateDef {
  description: string;
  /**
   * True once the template probe has listed this template's fields from real
   * responses. Probed templates reject unknown fields; others accept them with a warning.
   */
  probed: boolean;
  fields: Record<string, FieldDef>;
  quirks?: string[];
}

/**
 * Where an element lives, which decides how access is checked:
 * - world: belongs to a world; the world's access level applies (default);
 * - account: the token owner's own data (profile, block templates), read-only here;
 * - catalog: World Anvil's shared lists (marker types, RPG systems), read-only here.
 */
export type Scope = "world" | "account" | "catalog";

export interface TypeDef {
  name: string;
  description: string;
  /** Default "world". */
  scope?: Scope;
  /** Route of the element itself, used by GET/PUT/PATCH/DELETE. */
  path: string;
  /** Granularity values accepted by GET, from the spec. */
  granularities: string[];
  defaultGranularity: string;
  /** Granularity used for backups and read-back: the most complete one. */
  backupGranularity: string;
  list?: ListRoute;
  /** Verbs this server allows for this type (the API may allow more, see apiVerbs). */
  verbs: Verb[];
  /** Verbs the API documents, when this server allows fewer (account and catalog types). */
  apiVerbs?: Verb[];
  /** Verbs confirmed by a live-test run (set from observed.ts only). */
  verifiedVerbs?: Verb[];
  /** "verified" once a live-test run observed this type in a real response (set from observed.ts only). */
  status?: "verified" | "unverified";
  /** Show only registered, non-hidden fields (types that may carry personal data). */
  outputAllowlist?: true;
  /** Direct reference to the world. Absent for the world type itself. */
  world?: WorldLink;
  /** Parent chain used when the world reference is missing, tried in order. */
  parents: ParentLink[];
  fields: Record<string, FieldDef>;
  /** Values set on create when the caller gives none (e.g. a note's undocumented type). */
  createDefaults?: Record<string, unknown>;
  /** Article only: template-specific fields. */
  templates?: Record<string, TemplateDef>;
  /** Things the API cannot do or does surprisingly for this type. */
  quirks: string[];
}
