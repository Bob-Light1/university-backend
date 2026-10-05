# Current task and handoff

Last updated: 2026-10-05.
Status: COMPLETED — phase 1-B row 2, legacy entitlement retirement.
Backend branch: `main`; starting commit: `5b23879`.

## Objective and delivered changes

The owner requested continued phase 1-B work. Row 2 is delivered in
[ERP_ROADMAP §0/§5](architecture/ERP_ROADMAP.md).
[The retirement note](architecture/features/entitlement-legacy-retirement.md)
owns the contract, registry review, audits, regression proof and validation.

- Remove writable Campus `features` / `aiEntitlement` and the unused AI-only
  GET/PUT administration routes and facade helpers.
- Preserve raw older-database reads, first-write migration and both audit ledgers;
  unified administration exposes the latest 20 decisions across both histories.
- Convert hydrated quota inputs to raw objects, and seed unified configuration
  through the shared fold with the fixture clock (307 documents / 39 collections).
- Reuse frontend guards for the mentor workspace and Results/Courses shortcuts.
  Browser QA checks actual light/dark preferences, navigation, direct routes and
  shortcuts. The screenshots exposed the shortcut defect after an intermediate
  green run; the focused red regression and final replay close it.
- Replace the vulnerable development-only watcher dependency with Node native
  watch mode; verify imported-file restart/SIGTERM and retain the audit gate.
- Synchronize course examples, exact census assertions and reference map in its
  separate repository; updated lessons remain marked for independent author review.

## Validation performed on 2026-10-05

Pre-retirement browser 126/126; complete Jest 1,634 tests / 80 suites; fixture
self-check 36/36; API/data journey 25/25; course 67/67; final browser 134/134
(exit 0). Screenshots inspected in both themes. Backend lint: 0 errors, 40 existing
warnings; touched frontend lint: 0 errors, one existing warning. Dependency gate,
localization, current loopback frontend build, relative links, reference map and
whitespace checks pass. Private evidence remains under ignored
`tests/fixtures/.generated/row2/`; no generated credentials are documented.

## Remaining boundaries and next action

No implementation work remains for row 2. CH-0 independent acceptance under
QA D-14 and earlier administrator acceptance remain pending under their existing
work items. The class-quota scope defect is unchanged (roadmap row 15 / course
05.2). Phase 1-B remains in progress; phase 2 has not started. Existing commercial
and effort tables remain their dated baseline. No live migration, deployment or
remote publication is performed. This completion does not approve a new product
or planning decision; resume further work from the owner's current instructions.

Previous task history: the authorized 2026-10-04 course publication pushed
`3351f9ccb739d9dc6c28133a84700a183b019622` and prior `62300ad` to `origin/main`.
Today's changes are separate local delivery commits, with code and docs together.
