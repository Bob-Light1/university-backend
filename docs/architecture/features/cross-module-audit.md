# Cross-module audit journal

## Objective and approved decisions

Phase 1-B row 8 is in design and prerequisite implementation. This increment
protects the existing document and permanent-deletion ledgers against Mongoose
bulk deletion paths that bypass their query hooks. It does not deliver the shared
journal, its business emitters, export or consultation settings.

The owner approved on 2026-11-11:

- Permanent retention of audit events. A configurable consultation window must
  not delete older events or make archival an irreversible operation.
- The new journal tracks mutations after publication. General consultation and
  download tracking are outside this work item; existing document access events
  are preserved.

No production migration, deployment, pricing change or later-phase work is
authorized by this increment. Independent CH-0 acceptance and target AI SLOs
retain their existing acceptance gates.

## Bricks and current sources

| Brick | This increment | Subsequent row-8 implementation |
|---|---|---|
| Backend | Shared deletion guard, both existing audit schemas, regression checks | Shared event contract, transactional emitters, scoped consultation and export |
| ERP frontend | No changed API, screen or environment variable | Follow every new consumed endpoint under CLAUDE.md section 12 |
| AI service | No change | Review only if an actual consumer is introduced |
| Public portal | No change | Preserve existing ownership and candidate boundaries |

Verified existing sources are `DocumentAudit`, `DeletionAudit`, result
`auditLog[]` and partner lead status history. Their different shapes and
guarantees do not establish an existing unified journal. The deletion ledger
also updates `filesRemoved` after external storage cleanup; blocking all updates
would break that existing workflow. This increment does not change that write.

### Verified entry points for the remaining emitter inventory

| Source | Observed workflow | Integration boundary still to establish |
|---|---|---|
| Document | `document.audit.model.js` and `services/document.service.js` already record events; retention also writes through the repository | Preserve historical reads and access events; distinguish published mutations from draft activity and cover direct retention/deletion writers |
| Result | `auditCorrection`, `archiveResult`, `lockSemester` and retake publication in `result.workflow.controller.js` can change already-published records | Journal actual prior state and changes, including bulk writes and the original result updated during a retake; retain embedded correction history |
| Final transcript | `final-transcript.model.js` permits parent signature and verification-token writes after validation/sealing | Review callers and generation/upsert paths; keep published transcript effects atomic with their event |
| Exam grade | `exam.appeal.controller.js:resolveAppeal` can update a published grade's `finalScore` before saving the appeal decision | Define a single transaction/event boundary for the grade and appeal, rather than logging only the response |
| Announcement | Administrative archive/pin/delete and the expiry repository sweep can change published or formerly published announcements | Include system actors and the actual affected rows in bulk expiry |
| Schedule | Student and teacher schedule schemas carry `publishedAt` and `SCHEDULE_STATUS.PUBLISHED` | Inventory canonical writes and mirror synchronization before deciding whether they describe one event or separate business mutations |
| Course | Globally scoped course approval/visibility differs from a campus publication status | Determine the publication predicate from the existing public-read contract; do not invent a campus on a global collection |
| Finance and partner | Expenses use approval/payment states; partner lead transitions have embedded history | Explicitly map effective business states to the accepted post-publication scope; preserve partner ownership and historical provenance |

This is an inspected starting inventory, not a claim of complete emitter coverage.
Publication predicates, changed-field allowlists and source deduplication must be
frozen against each caller before implementing the shared event contract. HTTP
method names or a literal `PUBLISHED` search alone do not define the business scope.

## Contract for the deletion guard

`protectAuditDeletions(schema)` is a shared schema plugin installed before model
compilation. The model name supplies the error context; no HTTP contract or new
API error code is introduced.

- Refuse `Model.deleteOne`, `deleteMany`, `findOneAndDelete` and its
  `findByIdAndDelete` alias before the database operation.
- Refuse `document.deleteOne` through document middleware as well as query
  middleware.
- Refuse the entire `bulkWrite` batch if any operation contains `deleteOne` or
  `deleteMany`, including unordered and mixed insertion/deletion batches.
- Preserve insertion, reads and existing update semantics, including deletion
  ledger file cleanup enrichment and session propagation.
- Preserve each schema's indexes, collection name and absence of TTL and
  soft-delete markers. There is no data migration or purge.

These are application-level Mongoose safeguards. Direct collection/driver calls
and database-administrator access are outside them. The checks do not claim that
all existing audit records are immutable against arbitrary updates.

## Campus, deletion and entitlement

The existing ledgers use `campusId`; neither gets a new campus field. Their
campus `RETAIN` relations remain unchanged. A consultation window is a read
policy, never a soft-delete marker or a TTL. The eventual shared event schema
must use the actual campus of its business entity; authenticated campus scope
and partner ownership remain mandatory for every reader.

Audit retention is an invariant, not a separately sold feature. Deletion guards
always run, independently of the originating module's entitlement. This
increment changes no tier, feature key or quota.

## Eleven-registry review

| Registry | Decision for this increment |
|---|---|
| 1. `app.js` | No new route or middleware |
| 2. Module facades | No new cross-module import or export; shared plugin only |
| 3. Feature registry | No new entitlement or commercial surface |
| 4. Hard-delete registry | Existing ledger `RETAIN` relations unchanged; no new model |
| 5. Soft-delete helper | Neither ledger gains a deletion marker or override |
| 6. Job registry | No cron or purge |
| 7. Fixture counts | Existing deterministic dataset unchanged; separate disposable proof |
| 8. Translations | No product text, notification or PDF change |
| 9. ERP services/navigation | No changed endpoint or consumer |
| 10. Course inventory | Run the course guard for the shared helper/schema changes |
| 11. Engineering map | Corrected before this note; record the actual protected paths |

## Acceptance for this prerequisite

- [x] Both schemas use the shared guard; query, instance and bulk deletion fail.
- [x] Regression tests demonstrate the original bulk bypasses and pin existing
  query/instance protection. The initial instance regression passed on the
  installed Mongoose 8.24.4; no pre-existing instance bypass is claimed.
- [x] Insertions and legitimate cleanup enrichment still work.
- [x] A disposable real MongoDB replica-set run proves retained bytes and no
  partial insertion in a refused unordered batch.
- [x] Feature, platform and test audits occur in order; regressions have negative
  evidence and findings are closed before acceptance.
- [x] Full Jest, lint, dependency gate and course checks have current evidence.
- [x] Roadmap and handoff retain row 8 as in progress, with the remaining work.

No manual-QA case update is needed for these internal Mongoose safeguards:
HTTP behavior, screens and manual workflows are unchanged. The eventual shared
journal needs cases for scope/roles, transactional event accuracy, consultation
windows, archived history and export before row 8 can close. No case registration
or manual verdict is claimed here.

## Remaining row-8 work

Freeze the shared event fields and all post-publication mutation sites against
the actual domain workflows, including system jobs and bulk operations. Existing
sources must retain their historical records and established consumers. Connect
each emitter with an atomic persistence boundary; a success-only HTTP hook is
insufficient evidence that every business mutation was journaled. Then implement
campus-scoped consultation/export, permanent archival and configurable
consultation windows, update every affected consumer, and complete the full
feature lifecycle including browser QA. This prerequisite alone does not close
the commercial claim of a complete audit log.

## Ordered audits and negative evidence — 2026-11-11

1. Feature audit after the initial 267-check targeted pass and the real MongoDB
   proof: the guard covers both models and rejects the whole batch before
   casting/dispatch. It preserves existing error context and write semantics.
   The initial assumption about an instance bypass was disproved by the actual
   test and removed from the final design; only the bulk bypass is confirmed.
2. Platform audit: existing campus/document `RETAIN` relations, indexes and
   `campusId` paths are unchanged. Deletion-ledger cleanup enrichment remains
   supported. All eleven registry decisions are recorded above; no HTTP contract,
   environment wiring or consumer changes are required for this prerequisite.
3. Test audit: six bulk regressions failed on the original schemas. Removing
   both plugin registrations makes all 16 final unit cases fail. Replacing
   `some` with `every` makes both mixed-batch cases fail; removing `deleteMany`
   detection causes two failures, and removing `deleteOne` detection causes
   four. Disabling the bulk guard makes the real MongoDB journey fail at the
   first bulk operation with a missing expected rejection. Every mutation was
   restored in `finally` before the final validation runs.

No unresolved finding remains within this deletion-guard prerequisite. This does
not certify update immutability or coverage of unimplemented business emitters.

## Dependency-gate correction — 2026-11-11

The first dependency gate fails on four newly reported Mongoose advisories.
The patch updates only Mongoose 8.24.4 to 8.24.7 and mquery 5.0.0 to 5.0.1;
the MongoDB driver and all three named audit exceptions remain unchanged.
The manifest's minimum compatible version follows the corrected 8.x release.

The [upstream 8.24.7 release](https://github.com/Automattic/mongoose/releases/tag/8.24.7)
and advisory references own the fixes:

- [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c):
  respect connection-configured filter sanitization.
- [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96):
  restrict discriminator lookup to registered own properties.
- [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4):
  prevent inherited-property writes during hydration, dotted assignment and merging.
- [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj):
  reject prototype paths in virtual definitions.

Six real-library regressions execute in isolated child processes. All six fail
on 8.24.4 and pass on 8.24.7; positive controls retain ordinary casting, literal
filters and legitimate virtuals/discriminators. The first sanitization probe used
`connection.set`, which takes a different storage path and stayed green; it was
corrected to the native connection's `config` storage before the six-case red run.
The owned MongoDB journey independently reproduces the connection-option failure
on 8.24.4 and passes all 24 checks on 8.24.7, including literal reads and rollback.
Production connection options are not changed by these regression checks.

Targeted validation after the update passes four suites / 273 tests. The dependency
gate passes with the same three exceptions; lint reports zero errors and the same
39 existing warnings. These targeted results do not replace the final full replay.

## Retained unsuccessful validation attempts

- The first full Jest replay passes 99 suites / 1,830 tests but fails the existing
  PDF protocol test's 95-second timeout. The final replay uses the installed
  `/usr/bin/google-chrome`; no assertion or timeout is relaxed.
- The first course guard reports 63/67 executable solutions passing. Its F2
  inventory assertions still expect 99 suites, while cold child-process checks
  also run concurrently with the full backend replay. Exact expectations and
  matching prose are updated to 101 suites; final validation runs sequentially.
- The initial dependency gate's four blocking findings and all failed security
  probes remain evidence of the correction, not accepted exceptions.
- The November 11 final full Jest and fixture attempts were interrupted before
  producing their final verdicts. No validation processes remain at the November
  12 resume; the remaining gates are restarted sequentially with persisted exit
  statuses. Partial logs are not treated as passing checks.

## Prerequisite acceptance — 2026-11-12

The existing-ledger retention prerequisite is complete. Product row 8 remains
in progress with the shared journal work described above.

| Check | Observed result | Date |
|---|---|---|
| Targeted Jest | Four suites / 273 tests pass after the Mongoose update | 2026-11-11 |
| Owned audit-retention MongoDB journey | 24/24; unchanged bytes on refusal, no partial batch, appends, transaction rollback and actual sanitization | 2026-11-11 |
| Full Jest with installed Chrome | 101 suites / 1,837 tests pass; includes actual PDF rendering and all six dependency regressions | 2026-11-12 |
| Fixture self-check | 36/36; byte-identical reseeding and all nine logins | 2026-11-12 |
| Existing API/data journey | 25/25 on its owned disposable replica set | 2026-11-12 |
| Backend lint | Zero errors / 39 existing warnings | 2026-11-11 |
| Dependency gate | Pass with the same three named exceptions; no new exception | 2026-11-12 |
| Course guard | 67/67 executable solutions and reference checks pass sequentially | 2026-11-12 |

Course F2.2/F2.4/F2.5 exact assertions and current prose now follow 101 suites
(85 unit, 14 integration and two contracts), 1,347 call sites and 65 parameterized
declarations. Historical inventory blocks, perturbation results and author-review
markers remain intact. No new lesson or Part B specification change is needed.

No browser replay is claimed for this internal schema prerequisite. Browser and
manual acceptance remain part of the eventual shared-journal delivery. Local
logs are ignored under `tests/fixtures/.generated/audit-retention-2026-11-11/`
and `tests/fixtures/.generated/audit-retention-2026-11-12/`; no generated account
catalogue, credential or screenshot is committed.
