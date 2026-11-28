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
| Language | TypeScript 6.0 (strict; 7 waits for typescript-eslint), Node.js 24+ (CI on 24 and 26, Docker image on 26) |
| MCP | Official MCP TypeScript SDK (stdio and Streamable HTTP transports, server-side auth helpers) |
| Tests | Vitest; offline by default with mocked HTTP |
| Lint/format | ESLint + Prettier |
| Packaging | npm package for stdio use; Docker image (GHCR, distroless, amd64) for hosted use |
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
- The editor's layout (stage C probe, first world): every paragraph is `[p]…[/p]`, line breaks are `[br]` inside a paragraph, and paragraphs are separated by a single `\n` (never a blank line). Empty paragraphs `[p][/p]` are very common. Headings sit on their own line (`[h2]…[/h2]`); the editor may add an id (`[h1|<uuid>]…[/h1]`). Lists are not `[li]`: the editor writes `[ul]` or `[ol]` then one item per line, `- `, `-- `, `--- ` for three levels, then `[/ul]`/`[/ol]`; items may be empty (`- `) or end with a space. Check lists are loose lines `[] text[br]` outside any block. The editor may leave long runs of empty paragraphs (hundreds) at the end of a field. Generic heading `[h|<id>]…[/h]`, tables on one line, `[center]`/`[right]`, `[color:#hex]`, `[aloud]`, `[spoiler]`, `[secret:<id>]` and `[img:<id>|…]` (no closing tag) also occur. A pasted web link is plain text (no `[url]`).
- Links to non-article elements are tags: `[category:<id>]text[/category]`, `[timeline:<id>]text[/timeline]`.
- A sidebar key-value line is only the exact form `--Key::Value--` alone on its line (key right after `--`, `::`, final `--`), optionally followed by spaces or tabs (the editor leaves a trailing space in family sidebars; the blanks are kept byte for byte). A list sub-item `-- name : value` is not one. Rendering confirmed live: `--Population::12--` displays as "Population / 12".
- `history` is a generic article field holding BBCode (stage C probe: organization articles; the template probe saw it on plain articles too, so it is not template-specific).
- A field may end with a newline: confirmed by the stage C probe (13 of 13 paragraph fields in the first world were blocked by it before the converter kept leading/trailing blanks apart).
- Mentions are stored as `@[Display name](Type:<uuid>)`. The editor writes the type `Article` with a capital A; elements created through the API may carry a template name in lowercase (`person`). They may follow a tag directly (`[p]@[…](…)`). **Confirmed live (stage C content test):** an API-written `@[Title](Article:<uuid>)` renders as a link to the target article. Write article mentions with type `Article`; link other elements with tags, `[category:<uuid>]…[/category]` and `[timeline:<uuid>]…[/timeline]`.
- Eras have no API route: `GET era` and `POST timeline/eras` answer the HTML 404 page (owner's reads, 2026-11-28). Eras are visible only in `timeline.eras` at granularity 2, as references (id, title, state) without dates. Read them through the timeline; `wa_describe` says so.
- Timelines and events (owner's reads of hand-made elements, 2026-11-28; unverified until a live report): `history.lane` is JSON text keyed by timeline ID, e.g. `{"<timelineId>":5}` (the editor's "Select Column" for a `parallel` timeline). `year` is text; `month`, `day`, `hour`, `minute` are integers (the spec types `minute` as text). "End Year" is a separate field: an event may have an end month, day, hour or minute but no `endingYear`. Adding an event does not change the timeline's `updateDate`. Values seen: timeline `type` "parallel", `version` "horae", `displayRenderType` "scaled", `showInToc`, `allowComments`; history `type` "historical", `displayRange`. `parsedContent` is rendered HTML duplicating `content`/`fullcontent`: never shown by the tools.
- The user profile (`GET user`) carries tokens and personal data according to the spec (`token`, `email`, `dob`, Discord tokens…): only a short list of public fields is ever shown.
- Image IDs are numbers (e.g. `[img:123]`); other element IDs are UUIDs.
- The API is beta: all routes live in the registry so they can be fixed in one place.

## Server rules (in code)

- **Access before content.** A world's level is checked before any World Anvil call that targets it (world reads, every list). An element read by ID is resolved to its world (own `world` field, else the parent chain) before anything is returned; if no chain leads to a world, the read is refused. A `blocked` world answers exactly like a missing element, everywhere.
- **Per-session state.** Remembered `updateDate`s and resolved worlds are stored per MCP session, never globally (HTTP mode serves several clients).
- **Truncation.** Over the size limit, `wa_get` suggests `fields`; lists suggest `offset`.
- **Writes.** Order is fixed: read current state → resolve world → check level → validate fields → check references (same world only) → check conflict → dry run stops here → backup (failure refuses the write) → write → read back and compare. Worlds are never created or deleted. New elements are private, and draft where supported; public only on explicit request.
- **Template fields.** Probed templates (`observed.ts` → `templates`) refuse unknown fields in the article tools; unprobed templates accept them with a warning; generic `wa_create`/`wa_update` warn. Field kinds inferred from names stay `kindConfirmed: false` until a real value confirms them.
- **References.** Every `{id}` sent must resolve to the target world. `internal` IDs (organization/location/rank types) are exempt. Images (stage E): `cover`, `portrait`, `flag` and other image references, and a new `[img:]` in a text, are accepted only when the image is read and belongs to the same world, otherwise refused. Account and shared elements (a block's template, its RPG system, a marker's type) must be readable and, if they name a world, name the target world. References to unregistered types, and to types without a read route (eras), are refused.
- **Conflicts without updateDate.** For an element returned without `updateDate`, the session keeps the content it last read; a write is refused if any of those fields now differs, and `expected_update_date` is refused.
- **Restore.** Never sends placeholder references (`{"id": -1}`). An image reference is restored only if the image is read and in the same world; otherwise it is left out and reported as not restored. A public backup is restored as private unless the call passes `restore_public: true`, for an existing or a deleted element alike.
- **Backups.** Default folder `$XDG_DATA_HOME/anvil-hammer-mcp/backups` (else `~/.local/share/...`), never relative to the current directory; `WA_BACKUP_DIR` overrides. Files 0600, folders 0700, retention by the timestamp in the file name.
- **Text fields (stage C).** Read tools show BBCode text fields as Markdown by default (`format: "bbcode"` for raw); write tools take Markdown unless `raw_bbcode: true`. The converter (`src/content/bbcode.ts`) guarantees a byte-identical round trip: anything it cannot convert exactly is kept as a `⟦raw BBCode⟧` placeholder. New text is written in the editor's form; a field keeps its own layout (mode, leading and trailing blank characters) when rewritten or appended to. Converted forms: paragraphs, line breaks (an empty line inside a paragraph is a line holding only `\`), bold, italic, strike (`~~`), headings h1–h6 (with id as `{#id}`), `[hr]` (`---`), one-line `[quote]` (`> `), the editor's `[ul]`/`[ol]` lists on three levels (`[ol]` reads as a numbered list), mentions, sidebar lines. Fallback is per block: a block that does not convert is ONE placeholder on its own line and the rest stays readable; a run of empty paragraphs is one `⟦[p][/p]×N⟧`; only a field with no readable block is in plain mode. Every placeholder carries a rule name (`placeholderShapes`), reported by the probe without content. Tag links `[category:]`, `[timeline:]`, `[secret:]`, `[img:]` added to a text are checked against the world like mentions (an image must be read and in the same world). Text sent back unchanged is not sent. Replacing a non-empty text field needs `replace_fields`; `append` (recommended) adds at the end and checks the existing text stayed intact. Mentions added to a text field must point to the same world (`Article` and template names resolve as articles; each target read once per session). Restore never converts.
- **Registry status.** A field is `verified` only once a live-test run has observed it in a real response. Entries from the spec or from the quirks above start `unverified`. Promote them from the live report (`registry.observed`) by adding them to `src/registry/observed.ts`, the only place that marks anything verified.
- **Version.** One source: `package.json` (server version and `User-Agent`). A release tag `v0.x.y` must match it.
- **Scopes (stage E).** A type is `world` (the world's level applies), `account` (the token owner's own data: `user`, `blocktemplate`, `blocktemplatepart`) or `catalog` (shared lists: `markertype`, `rpgsystem`). Account and catalog types are read-only in this server whatever the API allows (`apiVerbs`); only your own profile can be read; an account or catalog element that names a world follows that world's level (its world is read at the granularity where it appears, once per session). Lists with parent `none` (shared) or `user` (your account) take no `parent_id`.
- **Hidden fields.** A field marked `hidden` (rendered duplicates such as `history.parsedContent`, the profile's tokens and personal data) is never shown by the read tools; backups keep the whole element. A type with `outputAllowlist` (the user profile) shows only registered, non-hidden fields.
- **Types without a route.** `era` has no verb: reads, lists and references are refused with an explanation pointing to `timeline.eras`. `image` cannot be created (no upload).
- **Specialized tools (stage E).** `wa_upsert_secret` (attached to an article, `subscriber_group_ids` replaces the restriction, `[]` removes it) and `wa_upsert_timeline_event` (dates, links to articles, lanes) go through the same write service as every write. Without `id` they create (private by default), with `id` they update only what is given. An event's end needs its own year: nothing is deduced. Lanes are written as JSON keyed by timeline ID; on update, lanes of timelines kept are kept, lanes of removed timelines dropped, given lanes set; an unreadable stored lane refuses the change.
- **Tool groups.** `WA_TOOLS`: `full` (default), `essential` (`wa_describe`, `wa_get`, `wa_list`, `wa_list_worlds`, `wa_list_articles`, `wa_create_article`, `wa_update_article`, `wa_restore`), or a comma-separated list; an unknown name, or `wa_delete` without `WA_ENABLE_DELETE=true`, refuses the start.
- **Type status.** A type is `verified` once a live run observed it in a real response (`observed.ts`); `verifiedVerbs` lists the routes confirmed. `wa_describe` says which types are unverified.

## Hosted mode rules (stage D)

- **Transport.** `anvil-hammer-mcp http`: Streamable HTTP at `/mcp`. One MCP server per session, all sharing one tool context (one World Anvil client, so call spacing holds across sessions). A session is bound to the grant (token family) that opened it; another grant gets 404. Sessions close after 1 h idle; at most 20.
- **Authorization server.** Single user, public clients only, following the MCP authorization spec (2026-07-28 rules that apply: `iss`, no `offline_access` in PRM or `WWW-Authenticate`). Clients: Client ID Metadata Documents (CIMD) and pre-registered public clients. **No dynamic client registration**: no `/register`, no `registration_endpoint`.
  - CIMD: a `client_id` that looks like a URL is only ever a metadata document. Its host must be in `WA_OAUTH_CIMD_HOSTS` (default `claude.ai`) and checked before any network call; https on the default port, canonical form, a path. Fetch: no redirect followed, 5 s, 5 KB, JSON only. The document's `client_id` must equal the URL; `token_endpoint_auth_method` must be `"none"`; no secret. The requested redirect URI must be in the document **and** in `WA_OAUTH_REDIRECT_URIS` (default: Claude's callback and loopback URIs). Cache follows `Cache-Control`, bounded (24 h, 32 entries).
  - Pre-registered: `<oauth dir>/clients.json`, written by `add-client`, reloaded when it changes. Exact redirect URIs; no secret field accepted.
  - Loopback redirect URIs (`localhost`, `127.0.0.1`, `[::1]`): the port is ignored, nothing else.
  - `/authorize`: errors before the client and redirect URI are validated are shown on a page, never redirected; after that, errors are redirected with `state` and `iss`. PKCE S256 only. `resource`, when given, must be our MCP URL. Scopes: `mcp`, plus `offline_access` accepted.
- **Passphrase page.** The secret file holds a scrypt hash from `hash-passphrase` (at least 12 characters); plain text is refused at startup. 5 failures per address per 15 min and 20 in total per hour, a pause after each failure. The page shows the client name, the redirect host and a warning for loopback redirects; strict CSP (no script, no frames, `form-action` limited to us and the redirect origin), `no-store`.
- **Tokens.** Opaque random strings; only SHA-256 hashes are kept. Code: 5 min, single use (a reused code revokes what it produced). Access token: 30 min, in memory only. Refresh token: rotated at each use, the new one in the same response; 30 days idle, 90 days at most; persisted in `<oauth dir>/grants.json` (0600, atomic write). A rotated refresh token presented again revokes the grant (60 s grace for a lost response). Every refresh refusal is `invalid_grant`. `revoke-all` writes a marker that a running server applies at once.
- **HTTP.** Every route except `/healthz` checks the `Host` header (DNS rebinding). `/mcp` refuses a foreign `Origin`, and the bearer check (401 with `resource_metadata` and `scope`) runs before the body is read. `X-Forwarded-For` counts only when the connection comes from `WA_TRUSTED_PROXY` (the gateway); the gateway passes on only the reverse proxy's value.
- **Secrets.** Hosted mode reads keys from files only. A secret file that is missing, empty, not a regular file, or readable or writable by other users is refused at startup (the same check applies to any `*_FILE` in stdio mode).
- **Gateway.** The server container has no internet access and no published port. The nginx gateway relays HTTP from the port published on `127.0.0.1` to the server, and passes TLS through, chosen by SNI, to `www.worldanvil.com` and `claude.ai` on 443 only. The server resolves those names to the gateway (`extra_hosts`); TLS stays end to end. A new CIMD host needs both `WA_OAUTH_CIMD_HOSTS` and the gateway's map.
- **Health.** `/healthz`: data folders writable, no World Anvil call, no detail beyond folder names. `/healthz/worldanvil`: bearer token required; returns ok or the error kind, and the duration.
- **Technical log.** JSON Lines, one file per UTC day in `WA_LOG_DIR`. Tool calls: tool, type, world, element or parent ID, duration, result and an error category (never the message or content). Authentication events with the client IP address. Every line goes through the redactor. Retention by file date, 180 days by default.

## Live tests

Offline tests (`npm test`) never touch the network. Live tests (`npm run test:live`) are manual, never run in CI, and must go through the live-test harness: only the test world declared in a gitignored local file can be touched, and only elements whose title starts with `MCP-TEST-` and that are recorded in the gitignored test ledger. Never weaken the harness.

- Config: `live-test.config.json` (gitignored), `{"testWorldId": "...", "ledgerFile": "live-test.ledger.json"}`; path overridable with `WA_LIVE_CONFIG`.
- Keys: files only, `WA_APP_KEY_FILE` and `WA_AUTH_TOKEN_FILE`, not readable by other users (`chmod 600`): the server refuses them otherwise.
- Commands: `npm run test:live` (stage A read), `test:live:templates` (template probe, read-only), `test:live:write` (stage B writes, deletes what it created), `test:live:cleanup` (deletes everything in the ledger), `test:live:bbcode` (stage C BBCode probe and real-text round trip, read-only; its `localOnly` section may hold the owner's words and is never pasted), `test:live:content` (stage C content test; keeps its `MCP-TEST-` articles for the owner to check the rendering, then `test:live:cleanup`). Stage E: `test:live:coverage` (read-only: every type of the test world and the children of what it finds, your own profile and block templates, shared lists; field names and kinds only), `test:live:timeline` (creates its own `MCP-TEST-` parallel timelines and events, never touches hand-made ones, keeps them for a visual check, then `test:live:cleanup`), `test:live:types` (one `MCP-TEST-` element of each world type that can be both created and deleted, maps excluded, plus a location article; deletes everything). Their reports have a `promotion` section: what `observed.ts` may take. Prefix each with `WA_APP_KEY_FILE=... WA_AUTH_TOKEN_FILE=...`.
- Write mode: a `PUT` must prove it targets the test world (`world.id`, or a parent in the ledger or discovered in the test world); created elements are recorded in the ledger automatically; `PATCH`/`DELETE` only on ledger elements.
- Reads beyond the test world's own lists (stage E): child lists of elements discovered in the test world (or in the ledger); the token owner's own profile (`GET user` with the id `identity` returned) and block templates; the shared lists `markertypes` and `rpgsystems`. Account and shared elements are kept apart: they can never prove a create and are never written. Numeric IDs (images, markers…) must match the type they were listed as.
- Output: `live-test-report.json` (gitignored) and a printed summary holding structure only (field names, counts, pass/fail), safe to paste in a PR. Check details are sanitized: IDs and UUIDs are masked.
- Any failed check, including checks made in `afterAll` (cleanup, harness refusals), fails the run.
- The harness (`live/harness.ts`) has offline tests (`test/live-harness.test.ts`); they must keep passing.
