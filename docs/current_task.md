# Current task and handoff

Last updated: 2026-11-01.
Status: MANUAL ADMISSION REGISTRATION BLOCKED BY ERP PROJECT ACCESS; row 5 remains IN PROGRESS.
Branch: main. Owner requests logical continuation and appropriate local commits.
No push, deployment, production DDL or historical enrollment conversion.

## Objective and approved scope

Finish phase 1-B row 5 acceptance before further product implementation. Preserve
OA-1–OA-3, D-R24/D-R25, phase order, the dated effort forecast and independent CH-*
acceptance. The [admission note](architecture/features/online-admission.md#manual-acceptance-readiness-review--2026-11-01)
owns the contract, audits, current results and retained failed attempts.

Verified clean starting commits: backend `e1dfe39`, ERP `e1f85a2`, portal `f1be5c6`.
Only documentation changes: explicit unchecked manual acceptance gate, admission
readiness evidence, roadmap dashboard/row 5, QA dashboard and this handoff.
Both consumer working trees remain clean; no API consumer changes are required.

## Checks performed on 2026-11-01

- Reviewed the five durable manual cases against applied Workbench validator
  `202610220004`, admission constants/transition service, attachment blocker and
  permanent journey/browser assertions. Local payload/reference check passes:
  five unique expected IDs, nineteen action/expected pairs, eight existing source
  references. ERP-ADM-001–005 need no body revision; they are still not registered.
- The sandboxed network attempt fails with `AuthRetryableFetchError`. Its permitted
  retry passes Auth login and user-JWT project query: one visible project, zero
  ERP multi-campus projects. Project editor/admin membership cannot be verified.
  No service credential or membership/case/campaign/result mutation is used.
  A request to grant access through member management is pending with the owner.
- Reviewed source checkpoints and the existing ordered audit/eleven-registry
  evidence. No source or fixture structure changes; no application suite rerun.
- Documentation links/anchors, whitespace, tracking and final diff are checked
  before the scoped local documentation commit.

## Historical automated acceptance — 2026-10-31

These unchanged-source results are retained evidence, not checks rerun today.

- Full Jest: 96 suites / 1,780 tests pass with installed Chrome. Admission units
  pass 24/24; the owned disposable admission journey passes 40/40.
- Backend lint: zero errors, 39 existing warnings. Both actual dependency gates
  pass, with three named backend exceptions and none in the portal.
- Both consumer builds pass from current sources in owned temporary roots with
  loopback origins. ERP touched lint passes eight files; locales pass 190/190.
  Portal tests pass 64/64; lint, TypeScript and browser smoke 18/18 pass.
- Complete ERP browser replay: **202/202**, including **28 admission checks**;
  exit 0. Inspected administrator/manager captures in both themes and commercial
  states, enrolled dossiers, French desktop candidate and Arabic mobile RTL.
  Final log: `/tmp/erp-admission-visual-pty-2026-10-31.log`; ignored captures:
  `tests/fixtures/.generated/admission-closeout-2026-10-31-pty/`.
- Earlier Chrome startup failures and two signal-143 browser interruptions are
  retained in the canonical note. A direct persistent terminal completes the
  final replay. No assertion, test pattern or per-test timeout is weakened.

## Remaining manual gate and next action

ERP-ADM-001–005 remain prepared, not registered or executed. Their durable source
and import procedure are in [manual cases](../tests/manual/README.md). Verify actual
ERP editor/admin membership after the owner's access update, import through the
existing user-scoped CLI, compare the five saved bodies with the durable payload,
then complete the final admission acceptance review. Preserve
existing revisions, campaign snapshots and submitted results. Automated browser
checks do not establish manual verdicts. Keep row 5 in progress until these gates pass.

## Retained acceptance boundaries

- [Roadmap §5.1](architecture/ERP_ROADMAP.md#51--remaining-effort-forecast--2026-10-23)
  owns 25–38 person-days (planning allowance 36). GED installed-index rollout
  remains with [GED expiry safety](architecture/features/ged-expiry-safety.md).
- AI target SLOs, independent CH-0 and administrator acceptance remain with their
  owning notes. Row 13 hosted CI awaits an authorized push. No CH-2/CH-4, ERP
  phase-2 or independent Workbench phase-2 implementation starts here.
