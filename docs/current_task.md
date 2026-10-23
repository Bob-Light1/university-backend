# Current task and handoff

Last updated: 2026-10-23.
Status: IN PROGRESS — phase 1-B row 5 online admission.
Backend: main. The owner now explicitly requests appropriate commits for each brick.
Preserve the roadmap estimate and unrelated Workbench phase-2 implementation.

## Objective and decisions

Continue the roadmap and chain the next task after completion, preserving phase order.
OA-1–OA-3 are approved: candidate/private emailed link and manager uploads;
campus-configurable required categories, none by default; manager/director/admin
finalize enrollment. Only director/admin pronounces admission; no payment prerequisite.
[Online admission](architecture/features/online-admission.md) owns the contract and evidence.

## Implementation milestone

Backend dossier, private storage/capabilities, transactional enrollment/commission/
activation/outbox, shared student creation/import capacity, guarded attachment deletion,
private notification encryption and migration preparation are implemented. ERP and
portal sources are synchronized into their actual repositories from the reviewed
21-file ERP and 28-file portal manifests. Checksum guards passed and existing
AGENTS/context manual-QA documentation is preserved. The current request saves
these changes as repository-specific checkpoint commits; it does not close admission.

Checks actually run: full Jest 92 suites / 1,756 tests passes before the two final
contract/dependency suites; real admission journey 40/40; backend lint passes with
39 warnings; dependency audit gate passes with its two existing named exceptions.
The redirect dependency regression fails both cases on 1.16.0 and passes on 1.16.1.
Seven temporary backend mutants were killed and restored; clean four-suite replay
passes 28 tests; a later five-suite replay including mirrors passes 38. ERP build
succeeds with explicit local API configuration.
Portal tests pass 52 after all nine proxy mutants are restored; lint and types
pass. Final production build and browser QA remain pending. Course structural figures/prose are updated; the complete replay is now green.
Current pre-commit replay: seven backend suites / 44 tests pass against the
synchronized consumers; portal 52 tests, lint and TypeScript pass; ERP touched lint
and 190 locale/namespace combinations pass. The full course guard passes all
67 executable solutions, skips 14 documented snippets and resolves its references.

Browser diagnostics did not reach acceptance: the initial staged SPA had no API
configuration. Its build now targets the owned loopback API. A full browser replay
and screenshot inspection are required. Three candidate conflict/revoked-access
state regressions failed through the real component handlers and pass after correction.

## Remaining acceptance and current commit request

An earlier local browser command was rejected because automatic approval review
had exhausted its usage quota; it was not executed. Approved scoped source
synchronization and pre-commit checks are now available. Final browser, production
build and manual-case acceptance remain unfinished; do not mark row 5 delivered.
No permission is needed again for the local commits explicitly requested by the owner.

Manual cases ERP-ADM-001–005 are prepared in `/tmp/admission/manual-cases.json`.
The owner says the validation account will receive ERP-project editor access;
verify membership and then upsert through the Workbench CLI. No case is registered
yet. Never use a service key to elevate membership. No secrets belong in documents.

## Next action

The redirect patch, roadmap forecast and manual-QA documentation are committed
separately. Save the current backend/ERP/portal admission checkpoint and green
course update in their own repositories as explicitly requested. Preserve unrelated
Workbench phase-2 files. Keep row 5 in progress and record remaining acceptance.
No push, deployment, production DDL or historical conversion.

## Retained external acceptance

[Roadmap §5.1](architecture/ERP_ROADMAP.md#51--remaining-effort-forecast--2026-10-23)
owns the completed estimate (25–38 person-days; planning allowance 36).
Row 12 was inspected but not started as a dedicated delivery. GED installed-index
rollout remains a release task under [GED expiry safety](architecture/features/ged-expiry-safety.md).
AI target SLOs, independent CH-0 and administrator acceptance remain with their
owning notes. Row 13 hosted CI awaits an authorized push. No CH-2/CH-4 or phase-2
work is started by this regression maintenance.
