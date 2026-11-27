/**
 * Fields observed in real World Anvil responses by the live-test harness.
 * Only this file promotes registry entries to `verified`. Add to it only from
 * a live-test report (`registry.observed`), never from the spec or notes.
 *
 * Run of 2026-11-27 (stage A, PR #1), read-only, test world only.
 * Not observed: subscribergroup, timeline, history (none in the test world);
 * article.histories, article.secrets, world.genres; the category parent chain.
 */
export interface Observation {
  fields: readonly string[];
  /** World link confirmed at its registered granularity. */
  worldLink?: boolean;
  /** Parent-chain fields confirmed at their registered granularity. */
  parentLinks?: readonly string[];
}

export const LIVE_OBSERVED: Record<string, Observation> = {
  article: {
    fields: [
      "articleParent",
      "author",
      "authornotes",
      "category",
      "content",
      "cover",
      "creationDate",
      "credits",
      "editURL",
      "entityClass",
      "excerpt",
      "folderId",
      "footnotes",
      "fullfooter",
      "icon",
      "id",
      "isDraft",
      "isEditable",
      "isWip",
      "position",
      "pronunciation",
      "publicationDate",
      "scrapbook",
      "sidebarcontent",
      "sidebarcontentbottom",
      "sidepanelcontent",
      "sidepanelcontenttop",
      "slug",
      "state",
      "subheading",
      "subscribergroups",
      "tags",
      "templateType",
      "title",
      "updateDate",
      "url",
      "wordcount",
      "world",
    ],
    worldLink: true, // from granularity 1
  },
  category: {
    fields: [
      "articleRedirect",
      "creationDate",
      "custom1",
      "description",
      "editURL",
      "entityClass",
      "excerpt",
      "folderId",
      "icon",
      "id",
      "isBook",
      "isCollapsed",
      "isDraft",
      "isEditable",
      "isWip",
      "parent",
      "position",
      "slug",
      "state",
      "subscribergroups",
      "tags",
      "title",
      "updateDate",
      "url",
      "world",
    ],
    worldLink: true, // from granularity 2; parent chain not exercised (top-level categories only)
  },
  secret: {
    fields: [
      "article",
      "author",
      "content",
      "creationDate",
      "editURL",
      "entityClass",
      "folderId",
      "icon",
      "id",
      "isDraft",
      "isEditable",
      "isWip",
      "slug",
      "state",
      "subscribergroups",
      "tags",
      "title",
      "updateDate",
      "url",
      "world",
    ],
    worldLink: true, // from granularity 2
    parentLinks: ["article"], // from granularity 2
  },
  world: {
    fields: [
      "countArticles",
      "countFollowers",
      "countMaps",
      "countTimelines",
      "cover",
      "creationDate",
      "description",
      "entityClass",
      "excerpt",
      "folderId",
      "globalAnnouncement",
      "globalArticleIntroduction",
      "globalHeader",
      "globalSidebarFooter",
      "icon",
      "id",
      "isDraft",
      "isEditable",
      "isWip",
      "locale",
      "owner",
      "slug",
      "state",
      "subscribergroups",
      "subtitle",
      "tags",
      "theme",
      "title",
      "updateDate",
      "url",
      "worldSidebarContent",
    ],
  },
};
