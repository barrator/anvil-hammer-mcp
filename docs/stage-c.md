# Stage C — Content fidelity (Markdown and BBCode)

Read `CLAUDE.md` and `docs/architecture.md` (§5). **Start by presenting your plan**; do not write code before it is approved.

Goal: the assistant reads and writes Markdown, while existing World Anvil text is **never damaged**.

Out of scope: HTTP, OAuth, Docker (stage D); new types and helper tools (stage E); search (stage F).

## 1. Converter

- BBCode → Markdown for reading; Markdown → BBCode for writing, applied to every text field the registry marks as BBCode (not only `content`).
- Raw BBCode input still possible with an explicit flag.
- You may study the converter of wlcarden/worldanvil-mcp (MIT). If you reuse code, keep its copyright notice in the file and say so in the PR.

## 2. Preservation of unknown BBCode

- Any tag the converter does not know (World Anvil-specific tags, embedded secrets, sections, CSS classes, anything else) is preserved verbatim in both directions: wrapped in a recognisable placeholder when read, restored identically when written.
- **Round-trip guarantee**: reading then writing back an unchanged text produces byte-identical BBCode. Test it on a varied fixture set (invented content).

## 3. Editing text safely

- `wa_update_article` gains an **append** mode: adds text at the end of a text field without rewriting the rest. It is the recommended mode and the tool description says so.
- Replacing a whole text field requires an explicit confirmation parameter. The result reports any BBCode tag that was present before and is missing after.

## 4. Links between articles

- Support World Anvil mention syntax (of the form `@[Title](type:id)`) in both directions, with a Markdown representation the assistant can write easily.
- **Confirm the exact syntax with a live rendering test** in the test world before finalising: create a `MCP-TEST-` article linking to another `MCP-TEST-` article, and ask the owner to confirm in the PR that it renders as a link.

## 5. Sidebar key-value lines

`--Key::Value--` lines pass through untouched in both directions.

## What does not change

All safety from stage B: defaults, backups, conflict detection, read-back, access levels.

## Delivery

Offline tests: conversion both ways, unknown tags preserved, byte-identical round trip, append mode, replace confirmation, missing-tag report, mentions, key-value lines. Live test: article with mixed formatting, a mention and a sidebar key-value; read, append, read again; owner confirms rendering. Update `CLAUDE.md` with the confirmed mention syntax. Pull request to `main`.

## Review checklist (for the owner)

- [ ] Open the live test article in World Anvil: does the formatting look right? Does the mention render as a link?
- [ ] Take a hand-formatted article in the test world, read and write it back unchanged: is it identical?
- [ ] Is replacing a whole text field impossible without the confirmation flag?
- [ ] If code was reused from wlcarden, is the copyright notice there?
