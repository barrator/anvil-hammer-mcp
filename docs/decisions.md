# Decisions

One line per decision: date, decision, reason. Newest at the bottom.

| Date | Decision | Reason |
|---|---|---|
| 2026-11-27 | Build from scratch, inspired by three existing MIT projects, credited in the README | Existing projects are local-only (stdio), and their design choices (public proxy by default, 170 tools, unguarded delete) do not match this project's principles |
| 2026-11-27 | Name: `anvil-hammer-mcp` | Distinct from the three existing `worldanvil-mcp` projects |
| 2026-11-27 | TypeScript | Most complete MCP ecosystem; prior art is JavaScript |
| 2026-11-27 | English only (code, comments, README, docs) | Widest audience for a public project; one version to maintain |
| 2026-11-27 | Whole API covered through a type registry and generic tools (about 14 tools), plus specialized tools for frequent tasks | Future use cases must not require new code; avoid the context cost and confusion of one tool per type and verb |
| 2026-11-27 | Writes are direct, with a change summary; dry run on request only | Usable from a phone; safety comes from backups, read-back, private drafts and conflict detection |
| 2026-11-27 | Hosted auth: built-in single-user OAuth server with a passphrase (DCR + Client ID Metadata Documents + PKCE) | Most reproducible for someone without the owner's infrastructure: needs only Docker, a domain and a passphrase; works with Claude's custom connectors out of the box. A static token in the URL was rejected (secret visible in logs and screenshots); custom auth headers need approval in Claude |
| 2026-11-27 | Conservative defaults: 60 writes/hour, backups 90 days, logs 180 days, responses about 25,000 characters | Safety first; all configurable |
| 2026-11-27 | Egress limited to World Anvil through an egress proxy in docker-compose, from the first hosted release | Reproducible anywhere without touching the host firewall; World Anvil's IPs change (Cloudflare) so filter by domain |
| 2026-11-27 | Work split into stages A–F, each with its own brief, plan approval before code | Keeps each step reviewable; the owner reviews plans and PRs as a counterweight |
| 2026-11-27 | A registry field is `verified` only when the live-test harness has observed it in a real response; spec and notes entries start `unverified` | Notes can be wrong or outdated; only a real response is evidence |
| 2026-11-27 | An element's world is resolved from its own `world` field, else through its parent chain; reads are refused only when no chain is found | The `world` field is missing at some granularities; refusing too eagerly would block legitimate reads, guessing would leak |
| 2026-11-27 | `blocked` worlds answer exactly like missing elements | An attacker-controlled prompt must not learn that a blocked element exists |
| 2026-11-27 | World access is checked before any list call to World Anvil | Nothing about a blocked world should even be fetched when it can be avoided |
| 2026-11-27 | Remembered `updateDate`s (and resolved worlds) are stored per MCP session | HTTP mode serves several clients; one client's reads must not authorize another's writes |
| 2026-11-27 | Truncation notices suggest `fields` for `wa_get` and `offset` for lists | Each points to the parameter that actually helps |
| 2026-11-27 | Access file variable: `WA_ACCESS_FILE`; size limit variable: `WA_MAX_RESPONSE_CHARS` | Consistent `WA_` prefix |
| 2026-11-27 | Runtime dependencies: MCP SDK and zod only (zod is required by the SDK for tool schemas) | Minimal dependencies |
| 2026-11-27 | Live tests read keys from files only; the report holds structure only (field names, counts, pass/fail) | Runs on the owner's VPS where keys are files; the report must be pasteable in a public PR |
| 2026-11-27 | Node.js 22 or newer | Current LTS line |
