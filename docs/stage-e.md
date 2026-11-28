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

## Notes from stage B

Fields returned by World Anvil for timelines and history events but not in the registry yet (stage B write run, names only). Add them in this stage, with live verification of their kinds.

- **Timeline:** allowComments, almanac, author, backgroundImage, calendar, cover, displayCenterYear, displayCss, displayRenderType, likes, presentationParameters, showInToc, utdOffset, version, views.
- **History event:** author, backgroundColor, category, cover, dayOfRecurrence, displayDateName, displayRange, durationStartDay, durationStartWeekday, durationStartYear, editURL, endingSeconds, lane, likes, meta, monthsRecurrence, parsedContent, recurrencePeriod, recurrenceUnit, recurringAlmanac, seconds, stellarBodyPhase, stellarBodyRecurrence, type, weekdaysRecurrence.
- Already added in stage B for `wa_upsert_timeline_event` (verified names, kinds not yet confirmed by a value): hour, minute, endingHour, endingMinute, location, species, report, militaryConflict.
- Not to add: `isDraft` (timeline, history), and `state`/`isDraft`/`isWip` (subscriber group). The keys come back empty and are never stored.
- Not observed yet: timeline `eras`; history `characters`, `organizations`.

## Notes from stage C: forms kept as placeholders

The converter keeps these as `⟦…⟧` placeholders (exact round trip, but not readable Markdown). Convert them later only if real use calls for it; each conversion needs the same byte-for-byte check and a probe run.

- Inline: `[u]…[/u]`, `[color:#hex]…[/color]`, `[category:<id>]` / `[timeline:<id>]` openings and closings (the text between them is readable), unpaired or crossing `[b]`/`[i]`/`[s]`, uppercase tag spellings, tags with parameters other than heading ids.
- Blocks (one placeholder per block): tables (`[table]…[/table]` on one line), `[center]…[/center]`, `[right]…[/right]`, `[aloud]…[/aloud]`, `[spoiler]…[/spoiler]`, `[secret:<id>]`, `[img:<id>|…]`, the generic heading `[h|<id>]…[/h]`, check lists (`[] text[br]` lines), multi-line or nested `[quote]`, several blocks on one line, lists in another layout, loose text lines outside blocks.
- Paragraphs: empty `[p][/p]` (runs shown as `⟦[p][/p]×N⟧`) and whitespace-only `[p] [/p]`, on purpose.
- Sidebar-like lines that are not the exact `--Key::Value--` form (trailing blanks are accepted).
