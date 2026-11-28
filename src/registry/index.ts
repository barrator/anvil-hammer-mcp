import { COMMON, bb, notes, probe, ref, refs, ro, spec, without, worldRef } from "./build.js";
import { LIVE_OBSERVED, type ObservedKind } from "./observed.js";
import { SPEC_TYPES } from "./spec-types.js";
import { TEMPLATES } from "./templates.js";
import type { FieldDef, TemplateDef, TypeDef } from "./types.js";

const CORE: Record<string, TypeDef> = {
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
      // A generic article field: the template probe did not list it as template-specific, and the
      // stage C BBCode probe found BBCode in it (organization articles, second world).
      history: bb(),
      position: spec("integer"),
      wordcount: spec("integer", { writable: false }),
      publicationDate: spec("date"),
      cover: spec("ref", { refType: "image" }),
      secrets: spec("refs", { refType: "secret" }),
      histories: spec("refs", { refType: "history" }),
      editURL: spec("string", { writable: false }),
    },
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
      type: notes("string", 'Seen with the value "parallel" (owner\'s reads).'),
      histories: spec("refs", { refType: "history" }),
      article: spec("ref", { refType: "article" }),
      category: spec("ref", { refType: "category" }),
      eras: refs("era", {
        writable: false,
        note: "Granularity 2 only: references (id, title, state) without dates. No API route reads or writes eras.",
      }),
      // Names seen in the stage B write run (kinds not confirmed by a value yet).
      version: notes("string", 'Seen with the value "horae" (owner\'s reads).', {
        kindConfirmed: false,
      }),
      displayRenderType: notes("string", 'Seen with the value "scaled" (owner\'s reads).', {
        kindConfirmed: false,
      }),
      showInToc: spec("boolean"),
      allowComments: probe("boolean"),
      presentationParameters: spec("string"),
      utdOffset: spec("string"),
      calendar: ref("calendar"),
      almanac: probe("ref"),
      cover: probe("ref", { refType: "image" }),
      backgroundImage: probe("ref", { refType: "image" }),
      displayCenterYear: probe("string"),
      displayCss: probe("string"),
      author: ref("user", { writable: false }),
      views: ro("integer"),
      likes: ro("integer"),
    },
    quirks: [
      "No isDraft: the key comes back empty but is never stored (stage B write run).",
      "Eras are visible only in eras at granularity 2; there is no API route for eras (owner's reads).",
      "Adding an event does not change the timeline's updateDate (owner's reads).",
    ],
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
      year: spec("string", { note: "Text." }),
      month: spec("integer"),
      day: spec("integer"),
      endingYear: spec("string", {
        note: 'Text. A separate "End Year" field in the editor: an event may have an end month or day without it.',
      }),
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
      minute: notes("integer", "The owner's reads show an integer; the spec types it as text.", {
        kindConfirmed: false,
      }),
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
      lane: notes(
        "string",
        'JSON text keyed by timeline ID, e.g. {"<timelineId>":5}: the editor\'s "Select Column" (the event\'s column in a "parallel" timeline).',
        { kindConfirmed: false },
      ),
      type: notes("string", 'Seen with the value "historical" (owner\'s reads).'),
      displayRange: spec("boolean"),
      alternativeDisplayRange: spec("string"),
      displayDateName: spec("string"),
      backgroundColor: spec("string"),
      category: ref("category"),
      cover: ref("image"),
      meta: spec("string"),
      parsedContent: probe("string", {
        writable: false,
        hidden: true,
        note: "Rendered HTML of the text: it duplicates content and fullcontent, so the tools never show it.",
      }),
      // Recurrence and fine-dating names seen in the stage B write run (kinds unknown).
      seconds: probe("string"),
      endingSeconds: probe("string"),
      dayOfRecurrence: probe("string"),
      monthsRecurrence: probe("string"),
      weekdaysRecurrence: probe("string"),
      recurrencePeriod: probe("string"),
      recurrenceUnit: probe("string"),
      recurringAlmanac: probe("string"),
      stellarBodyPhase: probe("string"),
      stellarBodyRecurrence: probe("string"),
      durationStartDay: probe("string"),
      durationStartWeekday: probe("string"),
      durationStartYear: probe("string"),
      author: ref("user", { writable: false }),
      likes: ro("refs", { refType: "user" }),
      editURL: ro("string"),
    },
    quirks: [
      "No isDraft: the key comes back empty but is never stored (stage B write run).",
      'lane is JSON text keyed by timeline ID (owner\'s reads), e.g. {"<timelineId>":5}.',
      "year is text; month, day, hour and minute are integers (owner's reads).",
    ],
  },
};

const BASE: Record<string, TypeDef> = { ...CORE, ...SPEC_TYPES };

/** Does a JSON kind seen live confirm the registry's inferred kind? */
function kindMatches(observed: ObservedKind, def: FieldDef): boolean {
  switch (observed) {
    case "string":
      return def.kind === "string";
    case "number":
      return def.kind === "integer";
    case "boolean":
      return def.kind === "boolean";
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
      out[name] = { ...def, status: "unverified" };
      continue;
    }
    const fields: Record<string, FieldDef> = {};
    for (const [f, d] of Object.entries(def.fields)) {
      if (!obs.fields.includes(f)) {
        fields[f] = d;
        continue;
      }
      const seen = obs.kinds?.[f];
      if (seen && !kindMatches(seen, d))
        throw new Error(
          `Observed kind ${seen} for ${name}.${f} contradicts registry kind ${d.kind}.`,
        );
      fields[f] = { ...d, status: "verified", ...(seen ? { kindConfirmed: true } : {}) };
    }
    for (const f of obs.fields) {
      if (!(f in def.fields))
        throw new Error(`Observed field ${name}.${f} is not in the registry.`);
    }
    for (const v of obs.verbs ?? [])
      if (!(def.apiVerbs ?? def.verbs).includes(v))
        throw new Error(`Observed verb ${v} for ${name} is not a registered verb.`);
    out[name] = {
      ...def,
      status: "verified",
      ...(obs.verbs ? { verifiedVerbs: [...obs.verbs] } : {}),
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

/** Scope of a type: "world" unless the registry says account or catalog. */
export function scopeOf(def: TypeDef): "world" | "account" | "catalog" {
  return def.scope ?? "world";
}

/**
 * What the read tools may show of an element: hidden fields removed (rendered
 * duplicates, tokens, personal data); for allowlisted types, only registered fields.
 * Backups keep the whole element.
 */
export function visibleFields(def: TypeDef, element: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(element)) {
    const f = def.fields[k];
    if (f?.hidden) continue;
    if (def.outputAllowlist && !f) continue;
    out[k] = v;
  }
  return out;
}
