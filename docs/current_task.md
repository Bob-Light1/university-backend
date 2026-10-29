# Current task and handoff

Last updated: 2026-10-29.
Status: LOCAL FUNCTIONAL CHECKS COMPLETE; phase 1-B row 5 remains IN PROGRESS pending
valid dependency audits and Workbench case registration.
Branch: main. The owner requests logical continuation and appropriate local commits.
No push, deployment, production DDL or historical enrollment conversion.

## Objective and approved decisions

Continue admission acceptance in roadmap order, preserving the dated effort
forecast and independent Workbench phase-2 work. OA-1–OA-3 remain approved:
candidate/private-email-link and manager uploads; campus-configurable requirements,
none by default; management enrollment. Only director/admin pronounces admission;
no payment prerequisite. [Online admission](architecture/features/online-admission.md)
owns the contract, audits and evidence. Session start: backend 5e55a77, ERP e1f85a2
and portal 08494b9, all three clean; those checkpoint commits were already complete.

## Changes and verified milestone

- Backend scripts/audit-gate.js rejects incomplete/error registry reports and
  abnormal subprocess outcomes before interpreting findings. Eight regressions
  failed before correction and pass afterward. No dependency/exception changed.
- Portal src/lib/admission-proxy.ts compares Origin with the actual Host/protocol,
  preserving loopback hostname distinctions despite NextURL normalization.
  Two handler regressions failed before correction; a forwarded-host mutant was
  rejected/restored and the clean replay passes. Portal contract/map updated.
- Admission browser scenarios wait for menu transitions, select the activation
  Dialog instead of the Drawer, assert activation is absent after reload and
  diagnose failed candidate sessions before dependent actions. Journey failures
  retain error stacks. tests/manual/admission.cases.json durably stores the five
  prepared cases; its README explains scoped, history-preserving CLI import.
- Course F2.4 exact assertion and prose now measure 4,358 portal source lines.
  Curriculum patch version/changelog updated; author-review status remains.

Checks actually run: backend Jest 94 suites / 1,776 tests; backend lint (39 existing
warnings), plus final touched-file lint; admission journey 40/40; base journey
25/25; ERP build with explicit loopback API; portal 55 tests, lint, TypeScript and
rebuilt production build; course 67/67 and all references; full browser 202/202
(exit 0), including 28 admission checks. Captures inspected for ADMIN and
CAMPUS_MANAGER in both themes, read-only/hidden manager states, French desktop
and Arabic mobile candidates, including read-only views. JSON/source references,
local documentation links and whitespace checks pass. No base fixture changes.
Initial sandbox port denials and MongoDB startup/connection timeouts were replayed;
they are not counted as successful checks. Earlier browser failures are retained
as regression evidence; their corrected full replay passes.

## Remaining gates and next action

Both dependency gates fail to obtain a valid npm registry report; the corrected
backend now diagnoses that network failure instead of falsely claiming zero
findings and stale exceptions. Restore registry access and rerun both gates.

ERP-ADM-001–005 are prepared, not registered or executed. Hosted Workbench login
fails at the network layer, before the validation account's ERP editor membership
can be verified. Restore access, verify membership and import the durable payload
through the documented CLI. Never use the service key to elevate membership or
rewrite campaign snapshots/results. Do not infer manual verdicts from automated QA.

The completed corrections, acceptance evidence and course inventory are saved
with scoped conventional commits in their own repositories. No ERP source changes
were needed. Portal correction: 0f2852f; backend audit correction: eda0f81;
course inventory: cef4cf0.
Keep row 5 in progress until the two external gates above pass; then review its
remaining acceptance and continue phase 1-B in order. Do not repeat already-green
local checks unless source changes or a new concern justifies a replay.

## Retained external acceptance

[Roadmap §5.1](architecture/ERP_ROADMAP.md#51--remaining-effort-forecast--2026-10-23)
owns 25–38 person-days (planning allowance 36). GED installed-index rollout stays
with [GED expiry safety](architecture/features/ged-expiry-safety.md). AI target SLOs,
independent CH-0 and administrator acceptance remain with their owning notes.
Row 13 hosted CI awaits an authorized push. No CH-2/CH-4 or ERP phase-2 work started.
