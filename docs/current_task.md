# Current task and handoff

Last updated: 2026-10-30.
Status: LOCAL SECURITY AND QA COMMITS COMPLETE.
Final full browser acceptance still requires a verified replay result.
Phase 1-B row 5 remains IN PROGRESS pending ERP Workbench editor access and case registration.
Branch: main. Owner requests logical continuation and appropriate local commits.
No push, deployment, production DDL or historical enrollment conversion.

## Objective and approved scope

Finish admission acceptance before further phase-1-B implementation. Preserve OA-1–OA-3,
D-R24/D-R25, the dated effort forecast, independent CH-* acceptance and separate
Workbench phase-2 work. The [admission note](architecture/features/online-admission.md)
owns the contract, audits and acceptance evidence. Starting repositories were clean:
backend 0f56abc, portal 0f2852f, ERP e1f85a2. Earlier implementation and browser
corrections were already committed; their checks remain historical evidence.

## Changes and historical checks from the prior handoff

- Restored registry access reveals body-parser and Zod high advisories plus a
  withdrawn portal braces exception. Backend body-parser moves 1.20.6 → 1.20.9
  within Express's existing range; its required qs/side-channel locks move with it.
- Portal Zod moves 4.4.3 → 4.6.7. Its withdrawn braces exception is removed;
  policy tests retain synthetic exceptions rather than obsolete production entries.
  Four malformed-report assertions fail before record-shape checks, then all 14
  policy cases pass.
- Both PDF engines explicitly select CDP. Zod 3 remains only in the unused BiDi
  parser with a named exception/removal condition, without forcing Zod 4 across
  the parser's major-version contract. Real engines launch and an academic PDF
  renders while Zod/BiDi module loading is refused.
- New gzip regression crashes with old body-parser and passes after correction;
  patched gzip/deflate preserve JSON and server health. The Zod collection-bound
  assertion fails on old Zod. CDP and exact-ID/stale-exception checks fail before
  their corrections, then all 17 targeted backend checks pass.
- Full backend Jest: 96 suites / 1,780 tests pass. Backend lint: zero errors,
  39 existing warnings. Portal: nine suites / 64 tests, lint, TypeScript and
  production build pass with an explicit loopback API target. Both dependency
  gates pass; backend retains three named unreachable-path exceptions, portal none.
- Portal browser smoke passes 18/18, including form submissions/refusals and real
  image optimization. The final ERP/admission browser replay result is unverified
  after two readiness failures; do not assume the earlier process is still running.
- Course F2.2/F2.4/F2.5 assertions/prose track 96 backend and nine portal suites;
  curriculum patch version/changelog updated, author-review status preserved.
  Original guard failed before these updates; all 67 solutions and references now pass.

## Commit verification — 2026-10-30

- The backend dependency gate passes with registry access: no unaccepted
  high/critical advisories and three documented exceptions.
- The targeted audit-policy and compressed-request suites pass all 16 tests.
  The PDF regression initially times out at 95 seconds; an isolated rerun with
  `PUPPETEER_EXECUTABLE_PATH=/tmp/chromium` passes in 4.2 seconds. No timeout
  threshold or assertion is weakened.
- Touched backend files pass ESLint. Portal Vitest passes nine suites / 64 tests
  and its dependency gate passes without exceptions. All 64 checked local
  documentation targets resolve, and whitespace checks pass in the three repositories.
- The course checker passes all 67 executable solutions and every cited path;
  its 14 illustrative snippets remain intentionally skipped.
- Full Jest, browser and production-build results above are historical checks,
  not reruns during commit preparation.
- Security changes are committed as backend `7348602` and portal `f1be5c6`.
  Browser-readiness fixes and this acceptance record are saved together; course
  inventories belong to their separate repository. No push or deployment.

## Workbench access and next action

Hosted login now succeeds with the existing validation account, but its user-JWT
project query cannot see ERP multi-campus. The owner answered yes to granting
editor access; subsequent checks still show no ERP membership. No service key,
membership mutation or manual verdict was used. Verify actual project-scoped
editor/admin access before importing the durable five-case payload with the
existing CLI: [manual cases](../tests/manual/README.md).

ERP-ADM-001–005 remain prepared, not registered or executed. Preserve campaign
snapshots and results. Obtain the final browser replay result, inspect captures
and record results. The owner's commit request is complete locally; remaining
admission acceptance is follow-up work, not authorization to advance product phases.
Keep row 5 open until case registration and the final acceptance review pass.

## Retained external acceptance

[Roadmap §5.1](architecture/ERP_ROADMAP.md#51--remaining-effort-forecast--2026-10-23)
owns 25–38 person-days (planning allowance 36). GED installed-index rollout stays
with [GED expiry safety](architecture/features/ged-expiry-safety.md). AI target SLOs,
independent CH-0 and administrator acceptance remain with their owning notes.
Row 13 hosted CI awaits an authorized push. No CH-2/CH-4 or ERP phase-2 work started.
