# Stage F — Release 1.1: search, write cap, journal, ID cache, API watch

Read `CLAUDE.md` and `docs/architecture.md` (§4, §6). **Start by presenting your plan**; do not write code before it is approved. This stage may be split into several pull requests; propose the split in your plan.

Goal: the features that make daily use smoother and safer over time.

## 1. Search

`wa_search` across titles, tags and text of articles, secrets and history events, from a local index in the `index` volume. Rebuilt on demand and refreshed incrementally after the server's own writes; stale-index age shown in results. Access levels apply to results.

## 2. Write cap

Maximum writes per hour (default 60), configurable. Beyond it, refuse with a clear message (limit, reset time). Counted across all write tools, including restore.

## 3. Change journal

JSON Lines in the `logs` volume: timestamp, tool, world, element, changed fields with before and after (summarised for long text), read-back result. Never a key. Retention 180 days by default. Documented format, suitable for an external weekly security review.

## 4. Discovered-ID cache

Learn internal IDs that no route lists (organization types first) from existing articles in accessible worlds; store them in the `index` volume; expose them in `wa_describe` and accept them by name in writes (resolved to the cached ID, with a clear error if unknown, explaining how to teach it: set the value once in the World Anvil editor).

## 5. API change watch

Weekly GitHub Actions workflow: download the official OpenAPI spec, compare with the reference copy in the repo, open an issue summarising differences if any.

## What does not change

All behaviour and safety from 1.0.

## Delivery

Offline tests per feature; live test of search and of the ID cache in the test world. Update `CLAUDE.md`, README and `CHANGELOG.md`. Version 1.1.0.

## Review checklist (for the owner)

- [ ] Does search ever return something from a `blocked` world?
- [ ] Trigger the write cap in the test world: is the message clear?
- [ ] Open the journal: is it readable, and free of keys?
- [ ] Set an organization type once in the editor; can the assistant then use it by name?
