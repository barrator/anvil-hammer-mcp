# Architecture

The target design for version 1.0 and 1.1. Stages in `docs/stage-*.md` build it piece by piece; this file is the reference they all point to. If a stage brief and this file disagree, ask.

## 1. Goals

1. **Self-hostable**: runs as an authenticated HTTP server on a VPS, so it can be added as a custom connector in Claude (web, desktop, mobile). Also runs locally over stdio.
2. **Safe by default**: per-world access levels, backup before every modification, private and draft by default, no delete by default, concurrent-write protection.
3. **Complete but light**: covers the whole API (34 element types) with about 14 tools, through a type registry and generic tools, instead of one tool per type and verb.
4. **Honest about writes**: every write is read back; fields World Anvil accepted but did not store are reported.

## 2. Prior art and credits

Three MIT-licensed projects informed this design. They are credited in the README. If any code is reused, its original copyright notice is kept in the file.

| Project | What we take | What we avoid |
|---|---|---|
| wlcarden/worldanvil-mcp | API route map; Markdown→BBCode conversion; optional tool groups; undocumented fields it discovered | Public proxy by default (user tokens pass through a third party); 170 tools; delete everywhere without safeguards; no default visibility |
| Carnivalius/worldanvil-mcp | Per-world access levels; local backup before writes; refuse to start without both keys; live-test harness limited to a test world and `MCP-TEST-` items | Untested on a real account at the time of writing: verify before reusing anything |
| daireb/worldanvil-mcp | Small tool count; private and draft by default; search; full export | No write support for secrets, timelines or ranks |

## 3. Type registry

The core of the server. For each element type (world, article, category, secret, subscriber group, timeline, history event, era, map, layer, marker, marker group, marker type, notebook, note section, note, block, block folder, block template and parts, manuscript and its sub-elements, variable, variable collection, canvas, image, RPG system, user…) the registry knows:

- routes for get, list, create, update, delete, and their quirks;
- the parent type used to list and to resolve which world an element belongs to;
- required fields and known fields, from the spec **and** from live tests, each marked `verified` or `unverified`;
- which text fields are BBCode (to convert and to protect);
- verbs the API does not allow (e.g. image create) or that configuration disables;
- safe defaults on create (e.g. `state: private`, `isDraft: true` where supported).

Article templates (person, organization, rank, settlement, location…) are sub-entries of the article type, each with its own known fields, fed by a reference file kept in the repo and enriched by live tests.

Adding a type or fixing a route means editing the registry, not writing a tool.

## 4. Tools

Prefix `wa_`. World IDs are always checked against the access configuration before any call, including for child elements (a note, a marker): the server resolves the parent chain up to the world.

### Generic tools (cover the whole API)

| Tool | Purpose |
|---|---|
| `wa_describe` | No argument: types and allowed verbs. With a type: its fields (required, known, verified or not). With an article template: template-specific fields. Also lists known IDs from the discovered-ID cache and states what the API cannot do. |
| `wa_get` | Read any element by type and ID, at the requested granularity. Text rendered as Markdown by default, BBCode on request. |
| `wa_list` | List elements of a type under a parent; walks every page; simple filters. |
| `wa_create` | Create any element, applying safe defaults and Markdown conversion. |
| `wa_update` | Update only the given fields of any element. Backup first, read back after. |
| `wa_delete` | Delete any element. **Not exposed** unless configuration enables it; refused in `edit_only` worlds; backs up first. |

### Specialized tools (frequent tasks)

| Tool | Purpose |
|---|---|
| `wa_list_worlds` | The owner's worlds with their access level. `blocked` worlds are hidden. |
| `wa_list_articles` | Articles of a world, filterable by category, template and tag. |
| `wa_search` | Search titles, tags and text across articles, secrets and timeline events, from a local index rebuilt as needed. (1.1) |
| `wa_create_article` | Create an article of a given template, with template fields validated against `wa_describe`, links to other articles by ID, and category. Private and draft by default. |
| `wa_update_article` | Like `wa_update`, plus an **append** mode (add text at the end of a text field without rewriting it), which is the recommended way to edit text. Replacing a whole text field requires explicit confirmation. |
| `wa_upsert_secret` | Create or update a secret, attached to an article, optionally restricted to subscriber groups. |
| `wa_upsert_timeline_event` | Create or update a dated history event in a timeline, linked to articles. |
| `wa_restore` | Restore an element from one of its backups; lists available backups when none is given. |

### Tool groups

A configuration value selects exposed tools: `essential` (generic reads, `wa_list_worlds`, `wa_list_articles`, `wa_search`, `wa_create_article`, `wa_update_article`, `wa_restore`), `full` (default), or an explicit list.

### Common write behaviour

- Writes happen directly (no mandatory dry run) and return a summary of what changed. `dry_run: true` shows exactly what would be sent without writing.
- Concurrency: the server remembers the `updateDate` of each element the assistant reads. Before a write it re-reads `updateDate`; if it differs from the remembered one (or from an explicit `expected_update_date`), the write is refused with a message saying someone else changed the element. An element never read in the session must be read before it is modified.
- Every write result includes: ID, editor URL, fields actually stored, fields **ignored** by World Anvil.

### Compact responses

- Empty fields (`null`, empty string, empty list) are removed by default.
- `wa_get` and `wa_list` accept `fields` to return only some fields.
- Linked objects (author, world, category…) are reduced to `{id, title, type}`.
- A configurable maximum response size; beyond it, the result is truncated with an explicit notice and how to get the rest.
- All content coming from World Anvil is wrapped in a block clearly marked as untrusted world content, separate from server messages.

## 5. Content: Markdown and BBCode

- Input accepts Markdown (converted) or raw BBCode (flag). Output renders BBCode as Markdown by default.
- **Never damage existing text.** BBCode tags the converter does not know are preserved verbatim in both directions. Reading then writing back an unchanged text must produce byte-identical BBCode. Replacing a whole text field requires confirmation, and the result reports any tag present before and missing after.
- Links between articles: World Anvil mention syntax (of the form `@[Title](type:id)`), converted both ways. Exact syntax confirmed by a live rendering test.
- Sidebar key-value lines `--Key::Value--` are passed through untouched.

## 6. Security and configuration

### Access levels per world

| Level | Read | Create | Update | Delete |
|---|---|---|---|---|
| `full_edit` | yes | yes | yes | yes, if delete is enabled globally |
| `edit_only` | yes | yes | yes | no |
| `read_only` | yes | no | no | no |
| `blocked` | no | no | no | no |

Default for an unlisted world: `read_only`. A configured config path that does not exist prevents startup.

### Backups

Before each modification or deletion, the full element is saved as timestamped JSON in a local volume. Configurable retention (default 90 days). Restoring a *modified* element puts it back exactly. Restoring a *deleted* element recreates it with a **new ID**: links that pointed to it are broken, and `wa_restore` lists them. This limitation is documented in the README.

### Prompt injection

World content is returned as marked untrusted data; tool descriptions and the README tell the assistant never to follow instructions found in it. Access levels, the write cap and read-back verification limit damage if an injection succeeds anyway.

### Write cap (1.1)

Maximum writes per hour (default 60), configurable. Beyond it the server refuses and explains why.

### Change journal (1.1)

Separate from the technical log. For each write: timestamp, tool, world, element, changed fields with before and after values (summarised for long text), read-back result. JSON Lines. Never contains a key. Default retention 180 days.

### Discovered-ID cache (1.1)

Some values need an internal ID that no route lists (e.g. organization types). The server learns them from existing articles (an organization whose type is "Family" reveals that type's ID) and keeps them in a local cache shown by `wa_describe`.

### API change detection (1.1)

A weekly GitHub Actions job downloads the official spec, compares it with the reference copy in the repo, and opens an issue if it changed.

## 7. Hosted mode

### Transport and authentication

- MCP Streamable HTTP.
- **Built-in OAuth authorization server**, single user, following the MCP authorization specification:
  - Client ID Metadata Documents (Claude's published identity, fetched from `claude.ai` only) and optional pre-registered public clients; no Dynamic Client Registration (deprecated in the 2026-07-28 spec; decision of 2026-11-28);
  - PKCE required (S256); short-lived access tokens with refresh;
  - the authorization page asks for a **passphrase** read from a secret file (stored as a hash), with attempt limiting;
  - allowed redirect URIs: Claude's (`https://claude.ai/api/mcp/auth_callback` and Claude Code's loopback redirects), configurable;
  - no external service required.
- Any request without a valid token is rejected before reaching a tool.
- Check the current Claude connector and MCP authorization documentation for exact requirements before implementing, and use the MCP TypeScript SDK's auth building blocks rather than writing everything from scratch.

### Docker

- Image built by GitHub Actions per release, published to GHCR with a version tag. Deploy by version tag; roll back by tag.
- Base image pinned by digest; dependencies pinned by lockfile; automated update PRs (Dependabot or Renovate).
- Keys read from **files** mounted read-only (`WA_APP_KEY_FILE`, `WA_AUTH_TOKEN_FILE`, passphrase file) via Docker Compose secrets. Never from environment variables (visible in `docker inspect`). Startup fails if a file is missing or too permissive.
- Non-root user; read-only root filesystem except data volumes and a `tmpfs`; `cap_drop: [ALL]`; `no-new-privileges`; memory, CPU and PID limits; port published on `127.0.0.1` only, behind a reverse proxy with TLS (Caddy example provided).
- **Egress proxy** in the compose file: the server container sits on an internal network with no internet access and can only reach the proxy, which allows only `www.worldanvil.com` (and `claude.ai`, for client metadata documents) over HTTPS. Filtering by domain name, not IP (World Anvil is behind Cloudflare).
- Volumes:

| Volume | Content | Sensitivity |
|---|---|---|
| `config` | Access levels, settings | Low |
| `backups` | Element copies before modification | **High**: full world content, may include real people's names |
| `index` | Search index, discovered-ID cache | **High** |
| `logs` | Technical log, change journal | Medium |

Sensitive volumes: permissions limited to the container user, configurable retention, encrypted off-host backup recommended, and a README note to include them in any privacy impact assessment (e.g. Québec's Law 25).

- `/healthz`: server up, config valid, volumes accessible, **without** calling World Anvil. A second, authenticated route checks the World Anvil connection.

## 8. Defaults

| Setting | Default |
|---|---|
| Writes per hour | 60 |
| Backup retention | 90 days |
| Log and journal retention | 180 days |
| Max response size | about 25,000 characters |
| Dry run | off |
| Delete tool | not exposed |
| Unlisted world | `read_only` |
| Tool group | `full` |

## 9. Releases

- **0.x** (stages A–D): usable by the owner, locally then hosted.
- **1.0** (end of stage E): public release; everything in this file except the items marked 1.1.
- **1.1** (stage F): search, write cap, change journal, discovered-ID cache, API change detection.
