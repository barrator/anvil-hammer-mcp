import { LIVE_OBSERVED } from "./observed.js";
import type { FieldDef, FieldKind, TypeDef } from "./types.js";

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
  id: spec("string"),
  title: spec("string"),
  slug: spec("string"),
  state: spec("string", { note: "public or private" }),
  isWip: spec("boolean"),
  isDraft: spec("boolean"),
  entityClass: spec("string"),
  icon: spec("string"),
  url: spec("string"),
  subscribergroups: spec("refs", { refType: "subscribergroup" }),
  folderId: spec("string"),
  tags: spec("string", { note: "comma-separated" }),
  updateDate: spec("date"),
  creationDate: spec("date"),
  isEditable: spec("boolean"),
};

const worldRef = (granularity: string) =>
  ({ field: "world", granularity, status: "unverified" }) as const;

const BASE: Record<string, TypeDef> = {
  world: {
    name: "world",
    description: "A world: the top-level container for everything else.",
    path: "world",
    granularities: ["-1", "0", "1"],
    defaultGranularity: "0",
    list: { path: "user/worlds", parentType: "user" },
    verbs: ["get", "list", "create", "update", "delete"],
    parents: [],
    fields: {
      ...COMMON,
      subtitle: spec("string"),
      description: bb(),
      excerpt: spec("string"),
      locale: spec("string"),
      owner: spec("ref", { refType: "user" }),
      countArticles: spec("integer"),
      countMaps: spec("integer"),
      countTimelines: spec("integer"),
      countFollowers: spec("integer"),
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
      author: spec("ref", { refType: "user" }),
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
      wordcount: spec("integer"),
      publicationDate: spec("date"),
      cover: spec("ref", { refType: "image" }),
      secrets: spec("refs", { refType: "secret" }),
      histories: spec("refs", { refType: "history" }),
      editURL: spec("string"),
    },
    createDefaults: { state: "private", isDraft: true },
    templates: {
      location: {
        description: "Location template (the only template the spec documents).",
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
      person: { description: "Person template. Fields not documented by the spec.", fields: {} },
      organization: {
        description: "Organization template. Fields not documented by the spec.",
        fields: {
          type: notes(
            "ref",
            "Requires an internal type ID. Sending the type name returns 200 and stores nothing. No route lists the types.",
          ),
        },
      },
      rank: { description: "Rank template. Fields not documented by the spec.", fields: {} },
      settlement: {
        description: "Settlement template. Fields not documented by the spec.",
        fields: {},
      },
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
    list: { path: "world/categories", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("2"),
    parents: [{ field: "parent", type: "category", granularity: "2", status: "unverified" }],
    fields: {
      ...COMMON,
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
      editURL: spec("string"),
    },
    quirks: ["Sending 'parentCategory' does nothing; use 'parent' (from notes)."],
  },

  secret: {
    name: "secret",
    description:
      "A secret: hidden content, optionally attached to an article and restricted to subscriber groups.",
    path: "secret",
    granularities: ["-1", "0", "2"],
    defaultGranularity: "2",
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
      author: spec("ref", { refType: "user" }),
      editURL: spec("string"),
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
    list: { path: "world/subscribergroups", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [],
    fields: {
      ...COMMON,
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      description: bb(),
      position: spec("integer"),
      isDefault: spec("boolean"),
      isHidden: spec("boolean"),
      isAssignable: spec("boolean"),
    },
    quirks: [],
  },

  timeline: {
    name: "timeline",
    description: "A timeline of historical entries.",
    path: "timeline",
    granularities: ["-1", "0", "1", "2"],
    defaultGranularity: "1",
    list: { path: "world/timelines", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [],
    fields: {
      ...COMMON,
      title: spec("string", { requiredOnCreate: true }),
      world: spec("ref", { refType: "world", requiredOnCreate: true }),
      description: bb(),
      type: spec("string"),
      histories: spec("refs", { refType: "history" }),
      article: spec("ref", { refType: "article" }),
      category: spec("ref", { refType: "category" }),
      eras: spec("refs"),
    },
    quirks: [],
  },

  history: {
    name: "history",
    description: "A historical entry (dated event), shown on one or more timelines.",
    path: "history",
    granularities: ["-1", "0", "1", "2"],
    defaultGranularity: "1",
    list: { path: "world/histories", parentType: "world" },
    verbs: ["get", "list", "create", "update", "delete"],
    world: worldRef("1"),
    parents: [{ field: "timelines", type: "timeline", granularity: "2", status: "unverified" }],
    fields: {
      ...COMMON,
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
    },
    quirks: [],
  },
};

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
