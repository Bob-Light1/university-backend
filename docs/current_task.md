# Current task and handoff

Last updated: 2026-10-17.
Status: COMPLETED LOCALLY — phase 1-B row 13.
Backend: main, started clean at ffd6130. Portal: main, clean at 8159ba5.

## Objective and approved decisions

The owner requests continued phase 1-B work. Under roadmap §3, protect the public
admission funnel with row-13 tests/CI before extending row 5. The
[design/evidence](architecture/features/public-portal-test-foundation.md) own the
contract, eleven registries, audits, dependency decisions and exact validation.

Owner confirmed row 5: only director/administrator pronounces admission; the campus
manager prepares the dossier; no automatic payment prerequisite this version.
Row 5 is not implemented here. No push, deployment or later phase is authorized.

## Completed source work

- Portal source and installed lockfile are synchronized in the actual separate
  repository; isolated build/validation copy remains /tmp/phase1b-portal.
- Added six Vitest files (39 cases), fail-closed audit gate, root CI workflow,
  test/typecheck scripts and documentation. Patched Next 15.5.28 and vulnerable
  transitive chains; one named dev-only braces exception remains.
- Backend adds twelve controller/service antifraud cases and npm run test:portal,
  a reusable Chrome smoke with owned loopback ERP/Next processes and synthetic
  responses. No database/provider access in that portal harness.
- F2 course lessons/assertions and generated reference map are synchronized.

## Current validation and next action

Final full backend: 87 suites / 1,708 tests PASS, exit 0. Portal 39/39 PASS;
clean installs, build (117 pages/eight locales), explicit types, both lint checks
and dependency gates PASS. Backend retains forty existing lint warnings.
All 51 new unit cases and all 18 portal browser checks have negative evidence;
the positive portal browser passes 18/18 and screenshots are inspected.
Full course passes 67/67 with fourteen declared skips and current references.

The complete ERP browser replay passes 174/174 with natural exit 0. Final
screenshots were inspected across themes and administrator/campus-manager roles,
including frozen and hidden states. Logs: /tmp/portal-*.log; screenshots:
/tmp/portal-foundation-browser-permanent and /tmp/portal-foundation-erp-visual-final.
Initial socket/worker restrictions and disk/swap pressure caused timeouts; no
threshold was relaxed. The final full backend/course/browser replays resolve them.

Source changes are in backend, portal and the nested separate course repository.
Coordinated local commits: portal 32118d0, course 02274b5.
No push/deployment ran; the first hosted CI run remains a release follow-up.
Next product work: row 5 under the recorded decisions; design its remaining intake
contract before code. Preserve the outstanding external acceptance below.

## Retained external acceptance

Existing-database GED installed-index rollout remains required on release;
[GED expiry safety](architecture/features/ged-expiry-safety.md). AI target SLOs
still require unavailable infrastructure; independent CH-0 and administrator
acceptance remain with their owning notes. No production DDL or deployment ran.
