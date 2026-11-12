# Current task and handoff

Last updated: 2026-11-12.
Status: COMPLETED — phase 1-B row 8 retention prerequisite; row 8 remains IN PROGRESS.
Branch: main. The owner requests continued roadmap work and scoped local commits.
No push, deployment, live delivery or pricing revision in this increment.

## Objective and approved decisions

Continue phase 1-B with the shared post-publication audit journal. On November 11,
the owner selects permanent event retention with configurable consultation and
mutation-only coverage, excluding general read/download tracking.
The [canonical scope and acceptance](architecture/features/cross-module-audit.md)
own the completed retention prerequisite and remaining unified-journal work.

## Completed changes

- `shared/lib/protect-audit-deletions.js` and both document/deletion audit schemas:
  refuse query/instance deletion and entire deletion-containing bulk batches.
  The confirmed original defect is bulk deletion bypassing individual hooks;
  the original instance tests already passed on Mongoose 8.24.4.
- Guard unit tests, synthetic ledger payload helper and owned MongoDB retention
  journey prove unchanged stored bytes, no partial batch, ordinary appends,
  rollback and legitimate file-cleanup enrichment. No TTL, purge, model or migration.
- `package.json`, lock and isolated dependency regressions: Mongoose 8.24.4 to
  8.24.7 and mquery 5.0.0 to 5.0.1 close the required dependency gate. All six
  dependency checks failed before and pass after; no driver change/new exception.
- Engineering map, roadmap and QA dashboard are synchronized. Course F2
  assertions/prose follow 101 suites in its separate repository; historical
  snapshots and author-review markers are preserved.

## Observed verification

- Full Jest: 101 suites / 1,837 tests pass with installed Chrome on November 12.
- Fixture self-check: 36/36; byte-identical reseeding and all nine logins.
  Existing owned API/data journey: 25/25. Sequential course guard: 67/67.
- November 11 targeted Jest: four suites / 273 tests. Owned audit-retention
  MongoDB journey: 24/24, including actual connection-option sanitization.
- Lint: zero errors / 39 existing warnings. November 12 dependency gate passes
  with the same three named exceptions.
- Six original bulk failures, all 16 final guard cases failing without the
  plugins, four unit mutation variants and the real-Mongo negative check have
  recorded evidence. Every temporary mutation was restored before final checks.
- Initial PDF/course failures and interrupted November 11 attempts remain in
  the canonical note. November 12 remaining gates finish sequentially with saved
  exit statuses. No browser replay or manual verdict is claimed for this internal
  prerequisite; no HTTP contract, consumer or environment wiring changed.

## Remaining row-8 work and next action

Complete the inspected emitter inventory and freeze the shared event contract.
Then implement transactional post-publication emitters, campus-scoped consultation
and export, configurable consultation windows, all affected consumers and full
browser/manual acceptance. Permanent archival is a read policy, never a purge.
Row 8 is not delivered by the completed retention prerequisite; no later phase starts.
The canonical note explains why no manual-QA case update is needed for this
internal change and identifies the future journal's required manual scenarios.

External gates retain their owners:
[CH-0 independent acceptance](architecture/features/ch0-fixture-completion.md),
[AI target SLOs](architecture/features/ai-operational-acceptance.md),
[GED release indexes](architecture/features/ged-expiry-safety.md),
[portal hosted CI](architecture/features/public-portal-test-foundation.md), and
[real WhatsApp activation](architecture/features/whatsapp-business.md).
CH-2 database choice D-06 remains open until CH-2 starts.

Logs and generated accounts stay ignored under `tests/fixtures/.generated/`;
audit-retention runs are grouped by 2026-11-11 and 2026-11-12. No credentials,
real personal data or generated captures are staged.
