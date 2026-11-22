# Current task and handoff

Last updated: 2026-11-20.
Status: IN PROGRESS — announcement emitters on the row-8 storage/writer foundation.
Branch: main. Backend HEAD remains `95920ac`.
The owner asks to continue the logical project sequence and describe external work.
The verified starting tree already contains the uncommitted storage/writer checkpoint
and its documentation. Those changes are preserved for a dedicated local commit.
Current scope continues with announcement management and automatic expiry emitters.
No push, deployment or live provider call.

## Objective and approved decisions

Continue phase 1-B row 8 with inventory checkpoint 1: permanent event storage,
explicit projections, a transaction-required writer and index preparation.
Roadmap D-R27/D-R28 retain permanent history, configurable consultation,
mutation-only coverage and the approved financial/admission scope. No later phase
or commercial revision starts. The [canonical contract](architecture/features/cross-module-audit.md)
owns implementation details and acceptance.

## Current increment

Announcement mutations now run through an owning service transaction. First
publication sets sticky eligibility; subsequent archive/edit/republication/pin and
soft deletion append explicit redacted events atomically. Expiry/unpin use bounded
keyset discovery with transactional rechecks and named system provenance. Existing
HTTP requests and consumer environment wiring stay compatible.

Current checks: 34 announcement unit/repository checks pass; owned HTTP/Mongo
journey passes 25/25. Foundation replay passes 388 targeted checks and its separate
32/32 database proof. Full regression, ordered audits, browser/course checks and
local commits remain in progress. Results below are historical November 12 evidence.

## Implemented foundation

- `modules/audit/`: constants, validation, opaque backend-owned source declarations,
  scalar/redacted projections, retry-stable operation/mutation identities, session-
  required service/repository, immutable `AuditEvent` and internal facade.
- Model guards cover existing-document saves, query/document update/delete,
  replacement, mixed unordered bulks and aggregate writes. Existing audit ledgers
  keep their update semantics; the shared deletion plugin accepts an optional
  error factory for the new journal's stable code.
- `scripts/prepare-audit-journal.js`: read-only inspection by default; explicit
  expand-only index creation, conflict/TTL refusal and idempotent verification.
  No historical scope/eligibility reconciliation is implemented.
- Hard-delete `RETAIN` declarations for campus and the currently deletable journal
  source types; facade/registry regression updates; separate unit and owned-database
  proof via `npm run test:audit-journal`.
- Engineering map, roadmap dashboard/row, QA dashboard and canonical feature note
  updated. Existing fixture counts and API/environment contracts are unchanged.

No production emitter or source definition is connected. No endpoint, export,
policy model/settings or ERP screen is delivered. Synthetic proof declarations
do not audit the existing payment workflow. Row 8 remains IN PROGRESS.

## Observed checks in this checkpoint

- Targeted Jest: four suites / 392 tests pass after fixes; earlier registry checks
  also include soft deletion and frontend entitlement keys.
- Owned replica-set proof: 32/32, including a driver automatic transient retry,
  commit/rollback, duplicate-ID refusal, unchanged bytes, no partial unordered
  mutation, redaction and idempotent index preparation.
- Feature audit reproduces aggregation-write (two tests), no-op session (two) and
  raw metadata (one) gaps red before correction. Platform review covers eleven
  registries; fourteen deliberate test-audit mutations fail and are restored.
- Final ownership review reproduces and closes missing `partnerId` on commission
  events; unassigned leads retain their nullable partner semantics.
- Initial sandboxed database run failed on local port permission (`EPERM`);
  approved local execution passes without weakening fixture safety guards.
- Full Jest with installed Chrome: 102 suites / 1,905 tests pass. Lint: zero
  errors / 39 existing warnings. Dependency gate passes with the same three
  exceptions. Fixture self-check: 36/36; base API/data journey: 25/25.
- Sequential course guard: 67/67 and all cited paths resolve. Its first 58/67 run
  identifies nine stale metric/router checks; source assertions and dated lesson
  maintenance notes are synchronized in the separate course repo. Historical
  examples and author-review markers are preserved.
- A real-Mongo aggregation-guard mutation fails as expected; the final restored
  proof passes 32/32. Historical retention results remain dated in the feature note.

## Remaining work and next action

Integrate the inventoried production emitters with exact source projections,
sticky eligibility, persisted before-state, identity/ownership and atomic rollback.
Include alternate routes/jobs/bulks, mirrors, payment effects, deletion cascades
and the documented GED assignment defect. Implement source scope/eligibility
reporting without fabricating historical events.

Implement consultation/export/settings and the ERP consumer with ten locales and
environment wiring. Finish the ordered full feature checks, browser QA and manual
case registration before closing row 8. ERP-AUD-001–008 remain proposed, unregistered
IDs. No Workbench update is required for this internal checkpoint because it changes
no manual workflow; its README was consulted and no manual verdict is claimed.

## External work retained

The [external-work table](architecture/features/cross-module-audit.md#external-work-retained-outside-local-journal-implementation)
owns actions and required evidence: independent CH-0 acceptance, provisioned AI
target/provider and agreed SLO workload, authorized GED TTL index retirement,
authorized portal push/hosted CI, and Meta sender/templates/private callbacks plus
one consented live WhatsApp run. They do not block local journal development.

Future journal release also requires target index inspection and explicit apply
of `scripts/prepare-audit-journal.js`; this script prepares indexes only, not
legacy eligibility. No production database was touched. CH-2 decision D-06 remains
open until that work item starts. Logs are ignored under
`tests/fixtures/.generated/audit-journal-2026-11-12/`; no credentials or personal data
are added to documentation.
