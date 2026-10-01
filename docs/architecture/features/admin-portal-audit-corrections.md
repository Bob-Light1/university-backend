# Administrator portal audit corrections

Started: 2026-09-30. Verified: 2026-10-01. Status: COMPLETED — AP-01 through AP-09.

## Problem and scope

The owner authorized correction and verification of AP-01 through AP-09 from
[the September 27 audit](../ADMIN_PORTAL_BROWSER_AUDIT.md). Preserve the selected
campus throughout administrator reads and writes, restore blocked creation and
finance flows, and align document reason validation and unconfigured plan labels.
Unexecuted integrations and unrelated roadmap features remain separate work.

| Brick | Scope |
| --- | --- |
| Backend | Results workflow scope; GED, mentor and staff list filters; regression tests |
| Frontend | Affected campus screens, hooks, services and forms |
| AI service / public portal | No contract change expected; verify consumers |

## Contract and invariants

Use the existing `campusId` query for requested campus context. ADMIN/DIRECTOR
may select a campus; scoped roles retain their authenticated campus regardless
of query or body values. Semester closure must require an effective campus and
scope result locking, transcript generation and ranking consistently. Preserve
existing `schoolCampus` creation payloads and document `campusId` persistence.
Keep deletion conventions, ownership, rate limits and module entitlement gates.
Optional blank finance dates become null (fee) or are omitted (payment); invalid nonempty dates remain errors.
Required document workflow reasons follow the server's minimum length.

## Verification and acceptance

- Reproduce each audit finding with an executable regression before correction.
- Verify both campuses and a scoped role, including unchanged campus B writes.
- Run focused and full backend tests, lint and dependency gate; frontend build,
  touched-file lint and locale parity; real-data journeys and browser checks.
- Review both themes, scoped/global roles and existing entitlement states.
- Record code, platform and test audits and all eleven registry decisions.
- Update the audit and roadmap with measured outcomes; do not close CH-2/4/5.

## Registry review

| # | Registry | Decision |
| --- | --- | --- |
| 1 | `app.js` | No route added or renamed; existing mounts retained. |
| 2 | Module `index.js` facades | No cross-module export added; existing facades retained. |
| 3 | `features.constants.js` | No module/offer added; existing keys and gates retained. |
| 4 | Hard-delete registry | No model or relationship added; existing ownership and deletion rules retained. |
| 5 | `soft-delete.js` | No strategy added; result workflow and GED list reuse derived filters. |
| 6 | `register-jobs.js`, engineering map §11 | No job or schedule change. |
| 7 | Fixture `COUNTS` | Seed shape and volumes unchanged. Scenario-created rows are assertions, not seed additions. |
| 8 | Backend catalogs, frontend locales ×10 | Two GED reason labels added in all ten frontend locales; existing null-plan label reused. No notification template change. |
| 9 | Frontend services, navigation | Result service accepts selected-campus query context. Existing route and feature keys retained. AI/public portal do not consume the changed administrator contracts; no environment wiring change. |
| 10 | Course hooks | No cited file moved or renamed; generated reference map unchanged. Supplemental course checks reveal count-snapshot debt (63/67 pass), recorded below. |
| 11 | Engineering map §§1/9/10/11 | Result campus contract and GED list scope documented in §10; module, route and job inventories unchanged. Frontend API reference documents `useCampusContext`. |

## Implementation and adversarial reviews

**Code review:** a global result closure without campus is rejected; query/body
conflicts are rejected; scoped identities cannot override their JWT campus.
Single-result reads and writes carry the same filter into the repository.
Aggregation requires actual ObjectIds because Mongoose does not cast `$match`.
The route helper now returns an ObjectId filter so snapshots and ranking remain
campus-scoped. The closure test asserts nonzero transcripts, not only HTTP 200.
GED list scope needed a server correction in addition to the frontend query.
Both findings were reproduced before correction. Required reasons use trimmed
length; invalid nonempty dates remain errors and blank dates submit.

**Platform review:** no schema, index, retention, ownership, quota, entitlement
or cron changes. Existing ADMIN/DIRECTOR global lists remain available without
an explicit campus; closure is the deliberate exception requiring a campus.
Mentor/staff scoped identities ignore attempted campus overrides. Result writes
validate student/class membership in the effective campus. No migration required.
Nodemailer 10.0.13 and brace-expansion patch updates were necessary to clear the
existing dependency gate; the actual email channel was tested against loopback
SMTP for successful UTF-8 delivery and recipient rejection. No real message sent. Upstream compatibility and fixes were checked against
[the Nodemailer changelog](https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md).

**Test review:** use actual login forms, API, built SPA and disposable MongoDB;
assert campus query, each returned row and database counts on A and B; verify
persisted creations and payment arithmetic. Compare all B results and transcripts
before and after A closure. Initial harness errors (wrong partner endpoint,
clicks during MUI menu exit, manager redirect, reused login budget) were corrected
and are not product findings. The visual entry point now uses an owned empty
working directory, temporary JWT key and inert external integrations; production
mode is refused before startup. Bootstrap success and refusal were smoke-tested. The canonical browser command passed with this isolation and exits with code 0. Its normal cleanup now invokes the existing PDF-pool, queue and rate-limit shutdown facades before stopping MongoDB. The shared Home check was outdated: the previously
approved public theme switch superseded its light-only expectation. The harness
now tests both states without changing the unrelated Home implementation.

## Regression evidence

Generated evidence is private and untracked under
`tests/fixtures/.generated/admin-corrections/`. Never copy fixture credentials.

- API campus regression: initial 9 failures / 7 passes; aggregation type check
  then exposed 2 failures. GED extension reproduced 3 failures / 18 passes.
- Single-result operations: six failures against copies of original controllers;
  repository scope: two failures against a copy of the original repository.
  Temporary original-code copies were removed after each run.
- Finance schemas: original schemas reject both blank-date cases; corrected
  schemas pass 11 cases (blank/null/absent/valid, invalid dates and overpayment).
- Original compiled frontend replay records 17 failed administrator scenarios
  and 5 passes (login and mentor/staff queries against the corrected server).
  Its additional manager scenario hit a cache-related 304; that harness issue
  is excluded from product findings and browser caching is now disabled.
  AP-08 server regressions are demonstrated by the earlier API red run.
- Latest backend full suite: 76 suites / 1,610 tests PASS. Focused final API and
  repository suites: 66 tests PASS. Backend lint: no errors, 40 existing warnings.
- Dependency gate PASS with the two existing named extract-zip exceptions;
  no new exception added. Actual SMTP checks: 2 PASS.
- Frontend build PASS (existing chunk-size warning), touched-file lint PASS,
  all 190 locale/namespace combinations PASS. Real-data API journey: 21/21 PASS.

- Fixture self-check: 16/16 PASS. Canonical `npm run test:visual`: 114/114 PASS,
  exit code 0, including the 23 new regression assertions (administrator and
  scoped manager). Existing entitlement and receipt scenarios remain green.
- Closing A locks 18 results and generates six transcripts with zero errors;
  all campus B results and transcripts remain byte-for-byte unchanged.
- Administrator and manager screenshots were inspected in light and dark themes;
  assertions verify the saved preference and rendered background color. The
  unconfigured-plan screenshot displays the translated label.

## Evidence locations and remaining boundaries

Backend entry points: `npm run test:visual`, `npm run test:journey`,
`npm run seed:test:self-check`, `npm test -- --runInBand`, `npm run lint` and
`npm run audit:ci`. Frontend: `npm run build`, touched-file ESLint,
`node scripts/check-missing-keys.js` and `node scripts/admin-form-validation-qa.mjs`.
Use the documented fixture prerequisites and disposable database guards.

The canonical browser log is
`tests/fixtures/.generated/admin-corrections/evidence/admin-full-visual-canonical.log`;
other verification and red-regression logs are alongside it. Screenshots are in
`tests/fixtures/.generated/visual/`: `admin-results-light.png`,
`admin-results-dark.png`, `admin-plan-light.png`, `manager-results-light.png`
and `manager-results-dark.png`. These generated artifacts remain untracked.

The canonical run on October 1 terminated normally. A separate Chromium process
(PID 78347), started September 30 at 21:36 local time and reparented to user
systemd, predates this run. It was left untouched because its original ownership
could not be established conclusively; no machine-wide cleanup is claimed.
The identified previous visual fixture and its PDF child were stopped.

AP-01 through AP-09 have no remaining correction work. Full administrator acceptance
still includes the original audit's unexecuted combinations and unavailable
AI/image/delivery integrations; this correction pass does not certify them.

The supplemental course check reports 63/67 executable lessons passing and no
missing-path change. Remaining failures: track 18 lesson 1 and F2 lessons 2, 4
and 5 (live counts versus recorded snapshots, including test/source counts).
The course is a separate repository and no file movement or architecture change
requires a new lesson here. Its existing content debt is preserved explicitly;
this work does not claim its check is green.
