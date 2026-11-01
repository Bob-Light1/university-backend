# Current task and handoff

Last updated: 2026-11-01.
Status: COMPLETED — phase 1-B row 5 source delivery and local acceptance.
Branch: main. Owner requests logical continuation and appropriate local commits.
No push, deployment, production DDL or historical enrollment conversion.

## Objective and approved scope

Finish admission acceptance, including registration of ERP-ADM-001–005 in the
independent Workbench. Preserve OA-1–OA-3, D-R24/D-R25, phase order, the dated
forecast and independent CH-* acceptance. The
[final admission review](architecture/features/online-admission.md#case-registration-and-final-acceptance--2026-11-01)
owns the contract, ordered audits, dated checks and retained failed attempts.

Verified clean starting commits: backend `0711bbe`, ERP `e1f85a2`, portal `f1be5c6`.
Backend changes since automated acceptance at `35f824d` are documentation only;
consumer sources remain unchanged and clean. This closeout updates the admission
note, roadmap dashboard/row 5, QA dashboard and handoff. No consumer or engineering
map change is required; the existing eleven-registry review remains applicable.

## Current completed checks — 2026-11-01

- The owner corrects project selection and adds the existing validation account
  to ERP multi-campus. Fresh user-JWT login confirms an active `editor` membership.
  The earlier absent-access checks remain dated in the admission note.
- The existing Workbench CLI imports all five durable manual cases through
  `save_case`, using only publishable configuration and the existing user account.
  ERP-ADM-001–005 are active at revision 1. All five saved bodies and authored
  revision bodies exactly match `tests/manual/admission.cases.json`.
- Before/after comparison preserves the ten existing cases and ten revisions.
  The ERP project now has fifteen cases/revisions; campaign, campaign-item and
  execution counts remain zero. No manual verdict is submitted or inferred.
- A second identical CLI import leaves all queried cases, revisions, campaigns,
  campaign items and executions unchanged. No service credential, membership
  mutation, independent Workbench source change or technical-project write occurs.
- Earlier local payload review passed five unique IDs, nineteen action/expected
  pairs and eight existing source references against the applied strict validator.
- Final acceptance reconciles the completed checklist, three ordered audits,
  eleven registries and the unchanged-source automated/browser evidence below.
  Documentation link/anchor, whitespace, tracking and diff checks precede the
  scoped local commit. No application suite is rerun for documentation/registration.

## Historical automated acceptance — 2026-10-31

These results are retained evidence, not checks rerun for this closeout.

- Full Jest: 96 suites / 1,780 tests; admission units 24/24; owned disposable
  admission journey 40/40. Backend lint: zero errors, 39 existing warnings.
- Both actual dependency gates pass, with three named backend exceptions and none
  in the portal. Both consumer builds, ERP touched lint/locales 190/190, portal
  tests 64/64, lint, TypeScript and browser smoke 18/18 pass.
- Complete ERP browser replay: 202/202, including 28 admission checks, exit 0;
  captures inspected across roles, themes, commercial states, enrolled dossiers,
  French desktop and Arabic mobile candidate flows. Final log:
  `/tmp/erp-admission-visual-pty-2026-10-31.log`; ignored captures:
  `tests/fixtures/.generated/admission-closeout-2026-10-31-pty/`.
- Earlier Chrome startup failures and signal-143 interruptions remain in the
  canonical note. No assertion, pattern or per-test timeout is weakened.

## Remaining work and next action

No source/local acceptance work remains for row 5; roadmap status is `LIVRÉ`.
ERP-ADM-001–005 are registered, not manually executed. Future campaigns require
an owned synthetic ERP environment and actual observed verdicts; registration
neither creates a campaign nor changes independent acceptance requirements.

Resume roadmap §3 within phase 1-B for the next implementation task. Row 7's
WhatsApp contract still needs D-R11 and Meta/template readiness; do not invent
those product choices. This completed handoff does not itself authorize a new
feature, release or independent Workbench increment.

## Retained acceptance boundaries

- Roadmap §5.1 retains its dated 2026-10-23 forecast of 25–38 person-days
  (planning allowance 36); row 5 closure does not silently recalculate it.
- GED installed-index rollout and admission preparation/reconciliation remain
  release prerequisites in their owning notes; no production migration occurs.
- AI target SLOs, independent CH-0 and administrator acceptance remain open in
  their owning work items. Row-13 hosted CI awaits an authorized push.
- No CH-2/CH-4, ERP phase-2 or independent Workbench phase-2 implementation starts.
