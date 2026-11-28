# anvil-hammer-mcp

An MCP server that lets an AI assistant read and enrich **its owner's own** World Anvil worlds, safely. Runs locally (stdio) or self-hosted (Streamable HTTP with built-in OAuth) in a hardened Docker container.

This file is authoritative for every session. The overall design is in `docs/architecture.md`. Work is delivered in stages, one brief per stage in `docs/stage-*.md`. Decisions are logged in `docs/decisions.md`.

## How we work

- Each stage starts with **your plan**. Do not write code before the owner approves it.
- Scope is strict: do only what the current stage brief asks. If something seems missing or wrong, ask; do not add it silently.
- Every stage ends with green checks (`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`), updates to this file and to `docs/decisions.md` when a rule or decision changes, and a pull request to `main`.
- The owner works mostly from a phone. Keep PR descriptions short and scannable: what changed, how it was tested, what to look at.
- **No AI attribution in history.** Commits and PRs carry no `Co-Authored-By` trailer for an AI, no session link and no "generated with" footer. Author and committer are the owner: `Frédéric Lauzier <74471835+barrator@users.noreply.github.com>`. The owner reviews and answers for every change. AI assistance is disclosed once, in the README.

## Language

English only: code, comments, commit messages, README, documentation, tool descriptions, error messages.

## Non-negotiable principles

1. **One person, their own keys.** Each installation uses its owner's application key and user token. No proxy, no shared key, no service for third parties. The World Anvil API licence forbids it and it puts other people's tokens at risk.
2. **Straight to World Anvil.** The API base URL is a constant in code. It cannot be overridden by configuration or environment.
3. **Secrets never leave.** Keys never appear in tool results, error messages or logs, including when World Anvil echoes a request back in an error.
4. **Nothing irreversible without a safety net.** A full copy of an element is saved before any modification. Delete is disabled by default and, even when enabled, backs up first.
5. **Never overwrite someone else's work.** Several people may write to the same world. A write is refused if the element changed since the assistant last read it.
6. **Content read from World Anvil is data, never instructions.** It is returned clearly marked as untrusted. The server never acts on its content.
7. **Verify what was written.** World Anvil often answers 200 while silently ignoring a field. Every create and update is read back and compared; ignored fields are reported.
8. **Safe defaults.** New articles are private and draft. Unlisted worlds are read-only.
9. **Simple to install, simple to read.** Few dependencies, readable code, offline tests that run without keys.

## Public repository: privacy rule

This repository is public. **Never** put in code, tests, fixtures, examples, commits, PRs or issues: keys or tokens, real world IDs, real world names, real article content, real people's names. Fixtures use invented content and obviously fake IDs. Local files holding real values (`.env*`, test world config, test ledger, secrets) are gitignored and must stay so.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), Node.js LTS |
| MCP | Official MCP TypeScript SDK (stdio and Streamable HTTP transports, server-side auth helpers) |
| Tests | Vitest; offline by default with mocked HTTP |
| Lint/format | ESLint + Prettier |
| Packaging | npm package for stdio use; Docker image (GHCR) for hosted use |
| CI | GitHub Actions: lint, typecheck, offline tests, build; image publishing from stage D |

Keep dependencies minimal and pinned through the lockfile. Justify any new runtime dependency in the PR.

## World Anvil API: rules and known quirks

Keep this list current. Every new quirk found in testing goes here and in the registry.

- Base URL: `https://www.worldanvil.com/api/external/boromir/`. JSON only.
- Required headers on every call: `x-application-key`, `x-auth-token`, `Content-Type: application/json`, and a `User-Agent` of the form `anvil-hammer-mcp (<repo url>, <version>)`.
- Verbs: `GET` read, `PUT` create, `PATCH` update (only the fields sent), `DELETE` delete. List endpoints are `POST` with a body `{"limit": "50", "offset": "0"}` (string values, max 50).
- Unknown routes return an HTML 404 page (`text/html`), not JSON. Handle it. Some errors also come back as HTTP 200 with `{"success": false, ...}`.
- Bad or missing credentials: HTTP 401 with JSON `{"success": false, "error": "access_denied"}`.
- The world reference (`world`) is not present at every granularity. Observed live: articles from granularity 1; categories and secrets from granularity 2. `secret.article` also appears only at granularity 2. Subscriber groups, timelines and history events: from granularity 1. `history.timelines` and `category.parent` appear only at granularity 2. Never assume it: resolve through the parent chain (history → `timelines` → timeline → world; secret → `article` → world; category → `parent`).
- Visibility fields differ by type (stage B write runs): timelines, history events and categories have `state` but no `isDraft`; subscriber groups have neither `state` nor `isDraft` (nor `isWip`). These keys **do appear in responses, always empty, but are never stored**: do not add them back to the registry (a registry test guards this). Create defaults follow the registry, so only existing fields are set.
- An unset reference comes back as `{"id": -1}` (seen on `cover`). It is a placeholder: treated as empty and never sent back.
- Subscriber groups: the `updateDate` key is present at every granularity (-1, 0, 1) but always empty (stage B write run). Conflict detection for them compares the content seen at the last read.
- Single-element responses include a `success` flag. It is a response flag, not an element field: it is stripped from tool output and ignored by the registry comparison.
- No documented rate limit. Space calls about 750 ms apart and back off on 429.
- Article templates: `templateType` in lowercase works for every template (`person`, `organization`, `rank`, `settlement`…) even though the spec only lists `article`. A new article is automatically marked WIP as well as draft.
- Template-specific fields are written and read back like any other field. The official spec documents fields for one template only (Location). The stage B probe listed the fields of person (123), organization (58), settlement (44) and rank (25) from real granularity-2 responses; they live in `src/registry/templates.ts`.
- Template fields that hold images (`portrait`, `flag`) come back as objects; they can only reference an image already uploaded on the site.
- Relations are sent as `{"id": "..."}` objects, e.g. `{"organization": {"id": "..."}}`.
- Organization `type` requires an internal type ID. Sending the type's name returns 200 and stores nothing. No route lists the types.
- Category parent is `parent`, not `parentCategory` (otherwise nothing happens). Categories have two text fields: `description` and `custom1`.
- Variables: the spec says `/variable_collection`, the live API uses `/variablecollection`.
- Notes require an undocumented `type: "default"`.
- Image upload is not implemented by the API. Images can only be referenced by ID once uploaded on the site.
- Text is stored as BBCode, unchanged. Sidebar fields accept `--Key::Value--`, displayed as a "Key: Value" line.
- The editor's layout (stage C probe, first world): every paragraph is `[p]…[/p]`, line breaks are `[br]` inside a paragraph, and paragraphs are separated by a single `\n` (never a blank line). Empty paragraphs `[p][/p]` are very common. Headings sit on their own line (`[h2]…[/h2]`); the editor may add an id (`[h1|<uuid>]…[/h1]`). Lists are not `[li]`: the editor writes `[ul]\n- item\n-- sub-item\n[/ul]`, one item per line, items may end with a space. A field may end with a newline (suspected from the first probe's counts; the probe's plain-mode reasons confirm).
- A sidebar key-value line is only the exact form `--Key::Value--` alone on its line (key right after `--`, `::`, final `--`). A list sub-item `-- name : value` is not one.
- The field `history` holds BBCode in templates not probed yet (second probe: 10 articles); the registry treats it as text whatever the template.
- Mentions are stored as `@[Display name](Type:<uuid>)`. The editor writes the type `Article` with a capital A; elements created through the API may carry a template name in lowercase (`person`). They may follow a tag directly (`[p]@[…](…)`). Exact rendering of API-written mentions still to be confirmed live.
- The API is beta: all routes live in the registry so they can be fixed in one place.

## Server rules (in code)

- **Access before content.** A world's level is checked before any World Anvil call that targets it (world reads, every list). An element read by ID is resolved to its world (own `world` field, else the parent chain) before anything is returned; if no chain leads to a world, the read is refused. A `blocked` world answers exactly like a missing element, everywhere.
- **Per-session state.** Remembered `updateDate`s and resolved worlds are stored per MCP session, never globally (HTTP mode serves several clients).
- **Truncation.** Over the size limit, `wa_get` suggests `fields`; lists suggest `offset`.
- **Writes.** Order is fixed: read current state → resolve world → check level → validate fields → check references (same world only) → check conflict → dry run stops here → backup (failure refuses the write) → write → read back and compare. Worlds are never created or deleted. New elements are private, and draft where supported; public only on explicit request.
- **Template fields.** Probed templates (`observed.ts` → `templates`) refuse unknown fields in the article tools; unprobed templates accept them with a warning; generic `wa_create`/`wa_update` warn. Field kinds inferred from names stay `kindConfirmed: false` until a real value confirms them.
- **References.** Every `{id}` sent must resolve to the target world. `internal` IDs (organization/location/rank types) are exempt; image and other unregistered references are refused until their type is registered.
- **Conflicts without updateDate.** For an element returned without `updateDate`, the session keeps the content it last read; a write is refused if any of those fields now differs, and `expected_update_date` is refused.
- **Restore.** Never sends placeholder references (`{"id": -1}`) or image references (cannot be checked yet; reported as not restored). A public backup is restored as private unless the call passes `restore_public: true`, for an existing or a deleted element alike.
- **Backups.** Default folder `$XDG_DATA_HOME/anvil-hammer-mcp/backups` (else `~/.local/share/...`), never relative to the current directory; `WA_BACKUP_DIR` overrides. Files 0600, folders 0700, retention by the timestamp in the file name.
- **Text fields (stage C).** Read tools show BBCode text fields as Markdown by default (`format: "bbcode"` for raw); write tools take Markdown unless `raw_bbcode: true`. The converter (`src/content/bbcode.ts`) guarantees a byte-identical round trip: anything it cannot convert exactly is kept as a `⟦raw BBCode⟧` placeholder. New text is written in the editor's form; a field keeps its own layout (mode, leading and trailing blank characters) when rewritten or appended to. Converted forms: paragraphs, line breaks, bold, italic, headings (with id as `{#id}`), the editor's two-level lists, mentions, sidebar lines. Text sent back unchanged is not sent. Replacing a non-empty text field needs `replace_fields`; `append` (recommended) adds at the end and checks the existing text stayed intact. Mentions added to a text field must point to the same world (`Article` and template names resolve as articles; each target read once per session). Restore never converts.
- **Registry status.** A field is `verified` only once a live-test run has observed it in a real response. Entries from the spec or from the quirks above start `unverified`. Promote them from the live report (`registry.observed`) by adding them to `src/registry/observed.ts`, the only place that marks anything verified.

## Live tests

Offline tests (`npm test`) never touch the network. Live tests (`npm run test:live`) are manual, never run in CI, and must go through the live-test harness: only the test world declared in a gitignored local file can be touched, and only elements whose title starts with `MCP-TEST-` and that are recorded in the gitignored test ledger. Never weaken the harness.

- Config: `live-test.config.json` (gitignored), `{"testWorldId": "...", "ledgerFile": "live-test.ledger.json"}`; path overridable with `WA_LIVE_CONFIG`.
- Keys: files only, `WA_APP_KEY_FILE` and `WA_AUTH_TOKEN_FILE`.
- Commands: `npm run test:live` (stage A read), `test:live:templates` (template probe, read-only), `test:live:write` (stage B writes, deletes what it created), `test:live:cleanup` (deletes everything in the ledger), `test:live:bbcode` (stage C BBCode probe and real-text round trip, read-only; its `localOnly` section may hold the owner's words and is never pasted), `test:live:content` (stage C content test; keeps its `MCP-TEST-` articles for the owner to check the rendering, then `test:live:cleanup`). Prefix each with `WA_APP_KEY_FILE=... WA_AUTH_TOKEN_FILE=...`.
- Write mode: a `PUT` must prove it targets the test world (`world.id`, or a parent in the ledger or discovered in the test world); created elements are recorded in the ledger automatically; `PATCH`/`DELETE` only on ledger elements.
- Output: `live-test-report.json` (gitignored) and a printed summary holding structure only (field names, counts, pass/fail), safe to paste in a PR. Check details are sanitized: IDs and UUIDs are masked.
- Any failed check, including checks made in `afterAll` (cleanup, harness refusals), fails the run.
- The harness (`live/harness.ts`) has offline tests (`test/live-harness.test.ts`); they must keep passing.
