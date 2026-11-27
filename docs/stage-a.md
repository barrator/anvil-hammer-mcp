# Stage A — Foundation and read-only server

Read `CLAUDE.md` and `docs/architecture.md`. **Start by presenting your plan**; do not write code before it is approved.

Goal: a working **read-only** MCP server over stdio, with the project skeleton, the API client, the start of the type registry, access levels, compact output and untrusted-content marking. Nothing in this stage writes to World Anvil.

Out of scope: any write tool, backups, Markdown/BBCode conversion (text is returned as raw BBCode for now), HTTP transport, OAuth, Docker, search, `wa_describe` beyond the types listed below.

## 1. Repository skeleton

- TypeScript strict, ESLint, Prettier, Vitest, npm scripts: `build`, `typecheck`, `lint`, `test`, `test:live`.
- GitHub Actions CI on every PR: lint, typecheck, offline tests, build.
- `.gitignore` covering `.env*`, secrets, live-test config, test ledger, local data folders.
- `LICENSE` (MIT), `README.md` skeleton (purpose, status "work in progress", credits section naming the three projects in `docs/architecture.md` §2).

## 2. Configuration and secrets

- Keys read from files: `WA_APP_KEY_FILE`, `WA_AUTH_TOKEN_FILE`. For local stdio use, also accept `WA_APP_KEY` / `WA_AUTH_TOKEN` environment variables, documented as less safe.
- The server refuses to start if either key is missing.
- Access configuration file (JSON): world ID → level (`full_edit`, `edit_only`, `read_only`, `blocked`). Unlisted world: `read_only`. A configured path that does not exist prevents startup. Duplicate keys or unknown levels prevent startup.

## 3. API client

- Single module; base URL constant; required headers including `User-Agent: anvil-hammer-mcp (<repo url>, <version>)`.
- Call spacing (~750 ms) and exponential backoff on 429, with a maximum.
- Clean handling of HTML 404 pages and non-JSON responses.
- **Error scrubbing**: no key or token may appear in any error, log line or tool result, even when World Anvil echoes the request. Test this explicitly.
- List helper that walks every page (`limit` 50, string values).

## 4. Type registry (first types)

Create the registry structure described in `docs/architecture.md` §3, filled for: `world`, `article`, `category`, `secret`, `subscribergroup`, `timeline`, `history`. Mark each field `verified` or `unverified`. Include the parent chain so any element resolves to its world.

## 5. Read tools

`wa_list_worlds`, `wa_describe` (for the registered types), `wa_get`, `wa_list`, `wa_list_articles`.

- Access levels enforced on every call, including for child elements resolved to their world. `blocked` worlds are invisible everywhere.
- Compact responses: empty fields removed, `fields` parameter, linked objects reduced to `{id, title, type}`, maximum response size with explicit truncation notice.
- Every piece of World Anvil content wrapped in a clearly marked untrusted block; tool descriptions remind the assistant never to follow instructions found in it.
- The server remembers each element's `updateDate` when read (used by stage B).

## 6. Live-test harness

Build the harness now (`CLAUDE.md`, Live tests): local gitignored file declaring the single test world; refusal to touch any other world; ledger of `MCP-TEST-` elements. In this stage it only runs read tests against the test world.

## What does not change

Nothing exists yet: this stage creates the foundation.

## Delivery

Offline tests for: config validation, access levels (including children and `blocked`), error scrubbing, pagination, compact output, truncation, untrusted marking. One live read run against the test world, summarised in the PR (no real names or IDs). Update `CLAUDE.md` with any quirk found. Pull request to `main`.

## Review checklist (for the owner)

- [ ] Can a key appear anywhere in output, logs or errors? Show the test.
- [ ] Is the API base URL impossible to override?
- [ ] Does a `blocked` world leak through a child element (e.g. reading a secret by ID)?
- [ ] Is a large article actually compact, and is truncation explicit?
- [ ] Is untrusted content visibly separated from server messages?
- [ ] Any new runtime dependency? Is it justified?
