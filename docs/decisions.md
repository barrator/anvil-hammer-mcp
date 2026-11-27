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
