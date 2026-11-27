# Stage B — Safe writes

Read `CLAUDE.md` and `docs/architecture.md`. **Start by presenting your plan**; do not write code before it is approved.

Goal: the server can create and update elements **safely**: access levels, safe defaults, backups, restore, conflict detection, read-back verification. Writes use raw BBCode in this stage.

Out of scope: Markdown/BBCode conversion, append mode and replace confirmation (stage C), HTTP and OAuth (stage D), types beyond those registered in stage A, secret and timeline helper tools (stage E), write cap and change journal (stage F).

## 1. Generic write tools

`wa_create`, `wa_update` for the registered types, and `wa_create_article`, `wa_update_article`.

- Safe defaults applied on create from the registry: `state: private`, `isDraft: true` where the type supports them. An explicit value from the caller wins, except that nothing becomes public without the caller asking for it explicitly.
- `wa_create_article`: template, template-specific fields, category, links to other articles by ID (`{"field": {"id": ...}}`). Unknown template fields are rejected **before** the call, with the list of known fields (from the registry).
- `dry_run: true` returns exactly what would be sent, without writing. Default off.

## 2. Read-back verification

After every create or update, re-read the element and compare with what was sent. The result lists: ID, editor URL, fields stored, **fields ignored** by World Anvil. Ignored fields are reported as a warning, not hidden.

## 3. Conflict detection

Before any update: re-read `updateDate`; refuse if it differs from the value remembered at the assistant's last read (or from `expected_update_date` if provided). An element never read in the session must be read first. The refusal message explains that someone else changed the element and asks to re-read.

## 4. Backups and restore

- Before any update, save the full element (highest useful granularity) as timestamped JSON in the backups folder. Retention configurable, default 90 days, with cleanup.
- `wa_restore`: lists an element's backups; restores a chosen one (itself a write: backed up, conflict-checked, read back).
- Restore of a deleted element (once delete exists) recreates it with a new ID and lists the links that pointed to the old ID. Document the limitation.

## 5. Delete

`wa_delete` implemented but **not exposed** unless the config enables it. Refused in `edit_only` and `read_only` worlds. Backs up first.

## 6. Access levels for writes

`read_only` and `blocked` refuse all writes, including through child elements. `edit_only` refuses delete.

## What does not change

Read tools, compact output, untrusted marking, error scrubbing, access configuration from stage A.

## Delivery

Offline tests for: defaults, explicit public only on request, unknown template fields rejected, ignored-field detection, conflict refusal, backup content and retention, restore, delete hidden and refused per level, child-element access. Live tests in the test world: create a `MCP-TEST-` person article with template fields and a link, update it, provoke a conflict (edit it in between), restore it; report results in the PR without real data.

The stage A live run could not observe subscriber groups, timelines or history events (none in the test world), nor the category parent chain. Stage B's live test must also create `MCP-TEST-` elements of these three types, plus a `MCP-TEST-` child category, read them back at every granularity, and use the report to promote their observed fields to `verified` (including the history → timeline → world and category → parent chains). Update `CLAUDE.md` with any new quirk. Pull request to `main`.

## Review checklist (for the owner)

- [ ] Can any path create a public article without an explicit request?
- [ ] Does a write ever happen without a backup first?
- [ ] Is a conflicting edit refused, and is the message understandable?
- [ ] Are ignored fields really surfaced (try an organization type by name)?
- [ ] Is delete invisible in the tool list with the default config?
- [ ] Can a `read_only` world be written through a child element?
