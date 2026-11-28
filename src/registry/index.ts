import { LIVE_OBSERVED, type ObservedKind } from "./observed.js";
import { TEMPLATES } from "./templates.js";
import type { FieldDef, FieldKind, TemplateDef, TypeDef } from "./types.js";

/** Field taken from the official spec, not yet observed live. */
const spec = (kind: FieldKind, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  status: "unverified",
  source: "spec",
  ...extra,
});

/** Field known from project notes (CLAUDE.md quirks), not yet observed by the harness. */
const notes = (kind: FieldKind, note: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  status: "unverified",
  source: "notes",
  note,
  ...extra,
});

const bb = (extra: Partial<FieldDef> = {}) => spec("string", { bbcode: true, ...extra });

/** Fields every element shares (spec "Ref" schemas). */
const COMMON: Record<string, FieldDef> = {
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
const without = (fields: Record<string, FieldDef>, ...names: string[]): Record<string, FieldDef> =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => !names.includes(k)));

const worldRef = (granularity: string) =>
  ({ field: "world", granularity, status: "unverified" }) as const;

const BASE: Record<string, TypeDef> = {
  world: {
    name: "world",
    description: "A world: the top-level container for everything else.",
    path: "world",
    granularities: ["-1", "0", "1"],
    defaultGranularity: "0",
    backupGranularity: "1",
    list: { path: "user/worlds", parentType: "user" },
    verbs: ["get", "list", "create", "update", "delete"],
    parents: [],
    fields: {
      ...COMMON,
      subtitle: spec("string"),
      description: bb(),
      excerpt: spec("string"),
      locale: spec("string"),
      owner: spec("ref", { refType: "user", writable: false }),
      countArticles: spec("integer", { writable: false }),
      countMaps: spec("integer", { writable: false }),
      countTimelines: spec("integer", { writable: false }),
      countFollowers: spec("integer", { writable: false }),
      worldSidebarContent: bb(),
      globalAnnouncement: bb(),
      globalHeader: bb(),
      globalSidebarFooter: bb(),
      globalArticleIntroduction: bb(),
      cover: spec("ref", { refType: "image" }),
      genres: spec("refs"),
      theme: spec("ref"),
    },
    quirks: [],
  },

  article: {
    name: "article",
    description:
      "An article. Persons, locations, organizations, ranks, settlements and other templates are all articles.",
    path: "article",
    granularities: ["-1", "0", "1", "2", "3"],
    defaultGranularity: "1",
    backupGranularity: "2",
    list: { path: "world/articles", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [],
    fields: {
      ...COMMON,
      title: spec("string", { requiredOnCreate: true }),
      templateType: spec("string", {
        requiredOnCreate: true,
        note: "Lowercase template name; the spec lists only 'article'.",
      }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      category: spec("ref", { refType: "category" }),
      author: spec("ref", { refType: "user", writable: false }),
      articleParent: spec("ref", { refType: "article" }),
      content: bb(),
      excerpt: spec("string"),
      subheading: spec("string"),
      pronunciation: spec("string"),
      sidebarcontent: bb(),
      sidepanelcontenttop: bb(),
      sidepanelcontent: bb(),
      sidebarcontentbottom: bb(),
      footnotes: bb(),
      fullfooter: bb(),
      authornotes: bb(),
      scrapbook: bb(),
      credits: bb(),
      position: spec("integer"),
      wordcount: spec("integer", { writable: false }),
      publicationDate: spec("date"),
      cover: spec("ref", { refType: "image" }),
      secrets: spec("refs", { refType: "secret" }),
      histories: spec("refs", { refType: "history" }),
      editURL: spec("string", { writable: false }),
    },
    // Stage C probe, second world: "history" held BBCode in 10 articles of templates not yet probed.
    textFieldNames: ["history"],
    templates: {
      location: {
        description: "Location template (the only template the spec documents). Not probed yet.",
        probed: false,
        fields: {
          alternativename: spec("string"),
          geography: bb(),
          population: spec("string"),
          demographics: bb(),
          demonym: spec("string"),
          government: bb(),
          history: bb(),
          climate: bb(),
          parent: spec("ref", { refType: "article" }),
          type: spec("ref", { note: "Location type, an internal ID." }),
          organization: spec("ref", { refType: "article" }),
        },
      },
      ...TEMPLATES,
    },
    quirks: [
      "templateType in lowercase works for every template even though the spec only lists 'article' (from notes).",
      "A new article is automatically marked WIP as well as draft (from notes).",
      "Template-specific fields are documented for Location only; read others from an existing article at granularity 2.",
    ],
  },

  category: {
    name: "category",
    description: "An article category in a world.",
    path: "category",
    granularities: ["-1", "0", "1", "2"],
    defaultGranularity: "1",
    backupGranularity: "2",
    list: { path: "world/categories", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("2"),
    parents: [{ field: "parent", type: "category", granularity: "2", status: "unverified" }],
    fields: {
      ...without(COMMON, "isDraft"),
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      description: notes("string", "One of the two category text fields.", { bbcode: true }),
      custom1: notes("string", "The second category text field.", { bbcode: true }),
      excerpt: spec("string"),
      parent: notes("ref", "Parent category. The field is 'parent', not 'parentCategory'.", {
        refType: "category",
      }),
      position: spec("integer"),
      isBook: spec("boolean"),
      isCollapsed: spec("boolean"),
      articleRedirect: spec("ref", { refType: "article" }),
      editURL: spec("string", { writable: false }),
    },
    quirks: [
      "No isDraft: the key comes back empty but is never stored (stage B write run).",
      "Sending 'parentCategory' does nothing; use 'parent' (from notes).",
    ],
  },

  secret: {
    name: "secret",
    description:
      "A secret: hidden content, optionally attached to an article and restricted to subscriber groups.",
    path: "secret",
    granularities: ["-1", "0", "2"],
    defaultGranularity: "2",
    backupGranularity: "2",
    list: { path: "world/secrets", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("2"),
    parents: [{ field: "article", type: "article", granularity: "2", status: "unverified" }],
    fields: {
      ...COMMON,
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      content: bb(),
      article: spec("ref", { refType: "article" }),
      author: spec("ref", { refType: "user", writable: false }),
      editURL: spec("string", { writable: false }),
    },
    quirks: [],
  },

  subscribergroup: {
    name: "subscribergroup",
    description:
      "A subscriber group: a set of readers or players with access to restricted content.",
    path: "subscribergroup",
    granularities: ["-1", "0", "1"],
    defaultGranularity: "1",
    backupGranularity: "1",
    list: { path: "world/subscribergroups", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [],
    fields: {
      ...without(COMMON, "isWip", "isDraft", "state"),
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      description: bb(),
      position: spec("integer"),
      isDefault: spec("boolean"),
      isHidden: spec("boolean"),
      isAssignable: spec("boolean"),
    },
    quirks: [
      "No state, isDraft or isWip: the keys come back empty but are never stored (stage B write run).",
      "updateDate key present at every granularity but always empty: conflict detection compares content instead (stage B write run).",
    ],
  },

  timeline: {
    name: "timeline",
    description: "A timeline of historical entries.",
    path: "timeline",
    granularities: ["-1", "0", "1", "2"],
    defaultGranularity: "1",
    backupGranularity: "2",
    list: { path: "world/timelines", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [],
    fields: {
      ...without(COMMON, "isDraft"),
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      description: bb(),
      type: spec("string"),
      histories: spec("refs", { refType: "history" }),
      article: spec("ref", { refType: "article" }),
      category: spec("ref", { refType: "category" }),
      eras: spec("refs"),
    },
    quirks: ["No isDraft: the key comes back empty but is never stored (stage B write run)."],
  },

  history: {
    name: "history",
    description: "A historical entry (dated event), shown on one or more timelines.",
    path: "history",
    granularities: ["-1", "0", "1", "2"],
    defaultGranularity: "1",
    backupGranularity: "2",
    list: { path: "world/histories", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [{ field: "timelines", type: "timeline", granularity: "2", status: "unverified" }],
    fields: {
      ...without(COMMON, "isDraft"),
      title: spec("string"),
      world: spec("ref", { refType: "world" }),
      content: bb(),
      fullcontent: bb(),
      year: spec("string"),
      month: spec("integer"),
      day: spec("integer"),
      endingYear: spec("string"),
      endingMonth: spec("integer"),
      endingDay: spec("integer"),
      significance: spec("integer"),
      timelines: spec("refs", { refType: "timeline" }),
      article: spec("ref", { refType: "article" }),
      characters: spec("refs", { refType: "article" }),
      organizations: spec("refs", { refType: "article" }),
      // Seen live in the stage B write run; added for wa_upsert_timeline_event (stage E):
      // finer dating and links to articles. Kinds come from the spec (or the name), not from a value.
      hour: spec("integer", { kindConfirmed: false }),
      minute: spec("string", { kindConfirmed: false, note: "The spec types it as text." }),
      endingHour: spec("integer", { kindConfirmed: false }),
      endingMinute: spec("integer", { kindConfirmed: false }),
      location: spec("ref", { refType: "article", kindConfirmed: false }),
      species: spec("ref", { refType: "article", kindConfirmed: false }),
      report: spec("ref", { refType: "article", kindConfirmed: false }),
      militaryConflict: {
        kind: "ref",
        refType: "article",
        status: "unverified",
        source: "probe",
        kindConfirmed: false,
        note: "Not in the spec; kind inferred from the name.",
      },
    },
    quirks: ["No isDraft: the key comes back empty but is never stored (stage B write run)."],
  },
};

/** Does a JSON kind seen live confirm the registry's inferred kind? */
function kindMatches(observed: ObservedKind, def: FieldDef): boolean {
  switch (observed) {
    case "string":
      return def.kind === "string";
    case "ref":
      return def.kind === "ref" && def.refType !== "image";
    case "array":
      return def.kind === "refs" || def.kind === "list";
    case "object":
      return def.kind === "ref" && def.refType === "image";
  }
}

function applyTemplateObservations(
  type: string,
  templates: Record<string, TemplateDef>,
  observed: Readonly<
    Record<string, { fields: readonly string[]; kinds: Readonly<Record<string, ObservedKind>> }>
  >,
): Record<string, TemplateDef> {
  const out: Record<string, TemplateDef> = {};
  for (const [tname, tpl] of Object.entries(templates)) {
    const obs = observed[tname];
    if (!obs) {
      out[tname] = tpl;
      continue;
    }
    for (const f of obs.fields) {
      if (!(f in tpl.fields))
        throw new Error(`Observed field ${type}.${tname}.${f} is not in the registry.`);
    }
    const fields: Record<string, FieldDef> = {};
    for (const [f, d] of Object.entries(tpl.fields)) {
      if (!obs.fields.includes(f)) {
        fields[f] = d;
        continue;
      }
      const seen = obs.kinds[f];
      if (seen && !kindMatches(seen, d)) {
        throw new Error(
          `Observed kind ${seen} for ${type}.${tname}.${f} contradicts registry kind ${d.kind}.`,
        );
      }
      fields[f] = { ...d, status: "verified", ...(seen ? { kindConfirmed: true } : {}) };
    }
    out[tname] = { ...tpl, fields };
  }
  return out;
}

/**
 * Apply live observations: observed fields and links become `verified`.
 * A field listed as observed but missing from the registry is a mistake and fails loudly.
 */
function applyObservations(base: Record<string, TypeDef>): Record<string, TypeDef> {
  const out: Record<string, TypeDef> = {};
  for (const [name, def] of Object.entries(base)) {
    const obs = LIVE_OBSERVED[name];
    if (!obs) {
      out[name] = def;
      continue;
    }
    const fields: Record<string, FieldDef> = {};
    for (const [f, d] of Object.entries(def.fields)) {
      fields[f] = obs.fields.includes(f) ? { ...d, status: "verified" } : d;
    }
    for (const f of obs.fields) {
      if (!(f in def.fields))
        throw new Error(`Observed field ${name}.${f} is not in the registry.`);
    }
    out[name] = {
      ...def,
      fields,
      templates:
        def.templates && applyTemplateObservations(name, def.templates, obs.templates ?? {}),
      world: def.world && obs.worldLink ? { ...def.world, status: "verified" } : def.world,
      parents: def.parents.map((p) =>
        obs.parentLinks?.includes(p.field) ? { ...p, status: "verified" } : p,
      ),
    };
  }
  return out;
}

export const REGISTRY: Record<string, TypeDef> = applyObservations(BASE);

export const TYPE_NAMES = Object.keys(REGISTRY) as [string, ...string[]];

export function getType(name: string): TypeDef {
  const t = REGISTRY[name];
  if (!t) throw new Error(`Unknown type "${name}". Known types: ${TYPE_NAMES.join(", ")}.`);
  return t;
}

export type { TypeDef, FieldDef } from "./types.js";
