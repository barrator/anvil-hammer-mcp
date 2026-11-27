# Stage E — Full API coverage and release 1.0

Read `CLAUDE.md` and `docs/architecture.md` (§3, §4). **Start by presenting your plan**; do not write code before it is approved.

Goal: the registry covers the whole API, the specialized tools for frequent tasks exist, and the project is ready for its public 1.0 release.

Out of scope: search, write cap, change journal, discovered-ID cache, API change detection (stage F).

## 1. Complete registry

- Add every remaining element type (maps and their layers, markers, marker groups and types; notebooks, note sections, notes; blocks, block folders, block templates and parts; manuscripts and all sub-elements; variables and variable collections; canvases; images (no create); eras; RPG systems; user), with routes, parents, required and known fields, BBCode fields, safe defaults and known quirks (`CLAUDE.md`).
- Every type and field marked `verified` or `unverified`. Live-verify at least: articles of several templates (person, organization, rank, settlement, location), categories, secrets, subscriber groups, timelines and history events. Others stay `unverified` until tested, and `wa_describe` says so.
- Article template reference file: known fields per template, sourced from live reads at granularity 2 in the test world.

## 2. Specialized tools

`wa_upsert_secret` (attached to an article, optional subscriber-group restriction) and `wa_upsert_timeline_event` (dated, linked to articles), both with every safety from stages B–C.

## 3. Tool groups

Configuration value `essential`, `full` (default) or an explicit list, as in `docs/architecture.md` §4.

## 4. Release 1.0

- README in final form: what it does and does not do, how to get both World Anvil keys, local and hosted installation, access configuration, safety model (defaults, backups and the restore limitation, conflicts, untrusted content), privacy note on volumes, "built for the author's own use, published as is, contributions welcome, no guaranteed support", credits.
- `CHANGELOG.md`, version 1.0.0, tag, GHCR image, npm package for stdio use.
- Final pass: no real data anywhere in the repository history (check fixtures, tests, docs).

## What does not change

All behaviour and safety from stages A–D.

## Delivery

Offline tests for every registry entry (routes, parents, defaults, quirks). Live verification report in the PR (types verified, fields found, new quirks), without real data. Update `CLAUDE.md`. Pull request to `main`; the owner tags the release.

## Review checklist (for the owner)

- [ ] `wa_describe` with no argument: is the list complete and understandable?
- [ ] Ask the assistant to create a secret for a subscriber group and a timeline event in the test world: correct, private, linked?
- [ ] With the `essential` group, how many tools appear?
- [ ] README: could a stranger install it from scratch?
- [ ] Search the repo for your world's name and IDs: nothing?
