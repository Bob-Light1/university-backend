# Current task and handoff

Last updated: 2026-10-16.
Status: COMPLETED LOCALLY — phase 1-B row 14; existing-database rollout remains.
Branch: main; started clean at 402eac0.

## Objective and approved scope

The owner requests the next logical phase 1-B work. Row 4 local acceptance is
complete and target infrastructure remains unavailable. Roadmap §3 permits
risk-reducing work to precede another row: retire business-document TTL before
admission attachments and HR expiry metadata. The
[design and evidence](architecture/features/ged-expiry-safety.md) own the contract,
three audits, eleven registries, acceptance and release procedure.

No deployment, production migration, provider call, pricing change or later phase.

## Completed changes

- Remove unused Document.expiresAt and the business TTL declaration. Strict model
  creates/updates discard the retired field; historical raw values stay on disk.
- Add scripts/retire-document-expiry.js: inspect by default; --apply drops only
  legacy single-field expiry TTL indexes, including custom names. Refuse unexpected
  TTL patterns; verify completion; preserve records and unrelated indexes.
- Add two Jest suites and a dedicated owned-database check, independently of the
  frozen seed. Business documents survive actual TTL passes; expired shares still
  disappear. Actual CLI dry-run/apply, replay and byte-for-byte preservation pass.
- Update CLAUDE, roadmap §0/row 14/D-R23 and the QA maintenance dashboard. Update
  course lesson 14.4 and F2 live-source counts. No consumer source, API route,
  dependency, fixture COUNTS or environment contract changed.

## Verification on 2026-10-16

- Full Jest: 86 suites / 1,696 tests PASS, exit 0. All 14 new cases have negative
  evidence; migration/share perturbations were detected and restored. Reintroducing
  the old index only in memory makes the real check fail on missing business rows.
- Dedicated real-TTL/CLI acceptance: 12/12 PASS, exit 0; at least two actual TTL passes.
- Backend lint: no errors, 40 existing warnings; final touched-code lint clean.
- Dependency gate PASS; two existing named exceptions unchanged.
- Fixture self-check 36/36; full course 67/67, 14 declared skips; references PASS.
- Fresh ERP build and 190 locale combinations PASS. Built in an owned /tmp
  directory with loopback API wiring; existing bundle-size warning remains.
- Complete browser: 174/174 PASS, natural exit 0; screenshots inspected across
  both themes and administrator/campus-manager roles, plus scoped read-only AI.
  Existing GED campus lists, reasons and citation drawers pass.

Logs: /tmp/ged-expiry-*.log; screenshots: /tmp/ged-expiry-visual.
Coordinated course commit: 955b796, local only.
Sandbox socket/subprocess restrictions were resolved through authorized validation
replays. No application/container already running was restarted. The general API
journey and provider integration are unchanged and were not separately rerun.

## Remaining work and next action

For every existing database, quiesce old schema instances, inspect/apply this
release's index migration, start the retired schema and recheck. A schema-only
release leaves installed TTL indexes active; restarting the old schema can recreate
one. No production DDL has run. Already deleted records are not recovered.

General GED raw DTO/campus reassignment remains an existing separate defect,
recorded in CLAUDE §5.2 and the row-14 note; TTL retirement does not close it.
Row 4 real-provider SLOs, CH-0 independent acceptance and administrator acceptance
remain with their owning notes. Recheck Git before the next authorized phase 1-B
item; no push, deployment or later phase is authorized.
