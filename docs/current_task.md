# Current task and handoff

Last updated: 2026-10-01.
Status: COMPLETED — AP-01 through AP-09 corrections and bounded verification.
Backend branch: `feat/fee-receipts-and-reminders`; frontend branch: `main`.

## Authorization and outcome

The owner authorized correction and verification of the nine confirmed findings in
[the administrator audit](architecture/ADMIN_PORTAL_BROWSER_AUDIT.md), then asked
to resume. All nine are corrected; implementation, registry reviews, regression
proofs and remaining coverage boundaries are in
[the correction note](architecture/features/admin-portal-audit-corrections.md).

Selected campus propagates through results, announcements, exams, GED and account
creation. The backend honors GED/mentor/staff list context and scopes result reads
and writes, including semester closure and ObjectId aggregation. Optional finance
dates submit, document reasons match server validation, and unconfigured offers
show a translated label. Required frontend consumers and all ten document catalogs
were updated. No schema migration is required.

## Checks and evidence

- Full Jest: 76 suites / 1,610 tests PASS; final focused API/repository: 66 PASS.
  Real loopback SMTP: 2 PASS after compatible dependency upgrades.
- Backend lint: 0 errors, 40 existing warnings. Dependency gate PASS with the
  two preexisting named extract-zip exceptions; no new exception.
- Frontend build and touched-file lint PASS; finance schema 11/11 and locale
  parity 190/190 PASS. Red-regression evidence is preserved in private logs.
- Disposable fixture self-check 16/16 and API/data journey 21/21 PASS.
- Canonical `npm run test:visual`: 114/114 PASS and normal exit code 0. The runner
  now closes PDF pools and other application resources through exported facades.
  Administrator/manager logins, both themes and entitlement/receipt checks pass;
  screenshots reviewed. Closing A locks 18 results and generates six transcripts
  with zero errors; all B results and transcripts remain unchanged.

Private, ignored evidence: `tests/fixtures/.generated/admin-corrections/evidence/`;
screenshots: `tests/fixtures/.generated/visual/`. Never commit fixture credentials.

## Preserved work and boundaries

Existing frontend Home/Login changes were preserved. Its old light-only shared
browser assertion now matches the already-approved theme switch. The visual
runner isolates dotenv/external channels and refuses production mode.

Supplemental course checks: 63/67. Track 18 lesson 1 and F2 lessons 2, 4, 5 have
count-snapshot failures; no referenced path changed. This separate-repository debt
remains explicit. Full administrator acceptance, external AI/image/delivery gaps
and CH-2/4/5 are not closed. Phase 1-B retains its ordering and 30–44 day estimate.

The identified old visual fixture and its PDF child were stopped. An older
Chromium process (PID 78347, September 30 21:36 local time, parent user systemd)
was left untouched because its original ownership is uncertain; it predates the
successful October 1 run. No machine-wide process cleanup is claimed.

All changes remain uncommitted; no commit, push or deployment was requested.
The sandbox has a bubblewrap mount error; approved escalated commands were used.
No implementation step remains for AP-01–AP-09. Further roadmap work requires
a new owner instruction; this handoff does not authorize a new phase.
