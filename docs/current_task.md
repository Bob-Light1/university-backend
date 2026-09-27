# Current task and handoff

Last updated: 2026-09-27.
Status: AUDIT PASS RECORDED — full administrator acceptance incomplete; defects remain.
Backend branch: `feat/fee-receipts-and-reminders`; frontend branch: `main`.

## Objective and authorization

Test administrator usage starting at the real login form. The owner selected a
local environment with fictional data and subsequently asked to continue.
Application fixes, commits, publication and deployment have not been performed.

Canonical scope, findings, checks and limitations:
[administrator browser audit](architecture/ADMIN_PORTAL_BROWSER_AUDIT.md).

## Current evidence

- Actual form login, API and ephemeral replica set; current frontend build passed.
- 13 administrator routes and 22 campus routes rendered under ADMIN. Substantive
  workflows and exact remaining coverage are listed in the canonical report.
- Accounts, profile/security, campus archive/restore, Premium offer, Finance
  freeze/reactivation, public content, global announcements, application review
  and competition lifecycle were exercised.
- Class, subject, student, teacher, parent and course creation persisted; course
  submission/approval and staff-role creation/edit/deactivation were tested.
- Fee/payment arithmetic and receipt, income, expense approval/payment, document
  workflow with valid reasons, and all six academic PDF preview types passed.
- Nine defect groups recorded. AP-01 is highest priority: a semester closure
  triggered from campus A locked 18 A results and 10 B results. Read-only
  aggregation proved the before/after change in the owned disposable database.
- Other findings: campus context lost in announcements/exams/documents; mentor,
  staff and partner creation missing campus; mentor/staff queries ignore campus;
  empty optional finance dates silently prevent submission; null-plan translation
  key; document lock labels a required reason optional. No product fixes applied.

## Runtime, artifacts and next action

The audit-owned browser, API/static servers and disposable database were stopped
cleanly. No production data was used. Synthetic changes were confined to that
runtime; the Finance usage state was restored to active before cleanup.

Evidence: `tests/fixtures/.generated/admin-portal-audit-2026-09-27/` contains
`audit-summary.json`, raw `results.json`, DOM/PNG captures, seven PDF files and
archived exploratory scripts under `harness/`. Runtime log:
`tests/fixtures/.generated/admin-portal-runtime.log`. Fixture account exports
remain private generated artifacts; never paste their credentials into reports.

The audit pass is recorded; **full administrator acceptance remains incomplete**.
The report identifies defects, blocked AI/image/delivery integrations and the
unexecuted workflow combinations. Raw results contain superseded harness failures
and missing transcript prerequisites; they must not be counted as product bugs.
The exploratory stages depend on prior state and are not a new CI suite.

Next action: address AP-01 campus-scoped reads and writes, then the other confirmed
findings, add meaningful regression coverage, and rerun affected browser journeys.
This is a follow-up recommendation, not an implementation started by this audit.
Do not mark CH-2/CH-4/CH-5 or product phases complete from these ad hoc results.

## Preserved prior work and limitations

The September 25 Home/Login presentation audit remains completed and is documented
in [the frontend public-entry audit](../../frontend/docs/architecture/features/public-entry-audit.md).
Its previous handoff was preserved in the generated evidence directory. Existing
uncommitted frontend presentation/theme/catalog work and backend branding-note
changes were preserved. Earlier frontend full-tree lint debt and historical
course-check failures remain open. No full Jest, dependency audit, course suite
or cross-platform journey suite has been rerun during this browser audit.
