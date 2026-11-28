/** Tool names and groups (WA_TOOLS: "essential", "full" or a comma-separated list). */
export const ALL_TOOLS = [
  "wa_list_worlds",
  "wa_describe",
  "wa_get",
  "wa_list",
  "wa_list_articles",
  "wa_create",
  "wa_update",
  "wa_create_article",
  "wa_update_article",
  "wa_upsert_secret",
  "wa_upsert_timeline_event",
  "wa_restore",
  "wa_delete",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

/** Generic reads, the world and article lists, article writes and restore (docs/architecture.md §4). */
export const ESSENTIAL_TOOLS: readonly ToolName[] = [
  "wa_describe",
  "wa_get",
  "wa_list",
  "wa_list_worlds",
  "wa_list_articles",
  "wa_create_article",
  "wa_update_article",
  "wa_restore",
];
