# Phase 1-B row 14 — GED expiry safety

Started/completed locally: 2026-10-16. Status: SOURCE DELIVERY AND LOCAL ACCEPTANCE COMPLETE. Starting backend: `main` at
`402eac0`, clean. The owner requested the next logical phase 1-B work.
Row 4 has completed local acceptance and awaits unavailable target infrastructure.
Roadmap §3 permits risk-reducing work to precede another row: removing business
document TTL deletion precedes admission attachments and HR expiry metadata.

## Problem, scope and bricks

`Document.expiresAt` and its MongoDB TTL index let an ordinary PATCH bypass the
permanent-deletion gate, storage teardown and audit. Removing a schema index alone
does not remove an installed database index. Retire the unused field and prepare
an explicit, idempotent migration that drops only legacy single-field
`expiresAt` TTL indexes from the documents collection. Preserve every business
row, historical raw expiry value, file reference, version, share and audit.

| Brick | Change |
|---|---|
| Backend | Document schema, index migration, regressions and real-TTL check |
| ERP frontend | Verify existing GED consumers; no expiry control or contract consumer exists |
| AI service | No API or ingestion contract change |
| Public portal | No GED expiry consumer |
| Course (separate repository) | Update the live-schema lesson and its executable assertion |

No automatic expiry replacement, HR policy, background purge, deployment or
production migration. General GED mass-assignment/campus reassignment remains
a separate existing defect; this work does not certify the whole update surface.

## Contract, campus, deletion and entitlement

Remove `expiresAt` from the Mongoose schema; strict model creates/updates discard
that unsupported field. No response envelope, route, enum or client payload changes.
Keep legacy raw values on disk rather than rewriting documents. The migration
addresses the model's actual collection, disables automatic model/index creation,
lists candidate indexes without writes by default, and requires `--apply` to drop
them. Do not use `syncIndexes`, bulk index removal or a hard-coded index name.
Refuse unexpected TTL key patterns before making any changes; verify completion.

`Document.campusId` and existing middleware retain their scope rules. Index DDL is
collection-wide maintenance, not an actor-scoped document mutation. No business
deletion runs; permanent deletion still requires the existing danger-zone gate.
The weekly `retentionUntil` soft-delete job and operational `DocumentShare` TTL
remain unchanged. Inherit the existing `document` entitlement; no new key.

## Eleven registries

| # | Registry | Reviewed change |
|---|---|---|
| 1 | app.js | None; existing routes |
| 2 | Module facades | None; maintenance script is not an inter-module API |
| 3 | Feature constants | None; existing document key |
| 4 | Hard-delete registry | None; existing document executor and campus relations |
| 5 | Soft-delete strategies | None; document remains deletedAt-based |
| 6 | Jobs | None; no automatic expiry replacement |
| 7 | Fixture COUNTS | None; owned TTL test uses separate runtime records |
| 8 | Catalogs | None; no user-visible text |
| 9 | Frontend services/navigation | None; verified consumer has no document expiry field |
| 10 | Course hooks | No path move; update existing lesson evidence and run guards |
| 11 | Engineering map | CLAUDE §5.2/§10: retired field, migration and remaining assignment defect |

## Acceptance and rollout

Follow CLAUDE §12 in order: regression tests before three distinct audits, full
Jest/lint/dependency gate, course checks, and complete existing browser QA with
screenshots inspected in both themes and existing global/scoped entitlement cases.
Run a separate disposable MongoDB check with TTL monitoring enabled; it must prove
the legacy index exists, dry run preserves it, apply removes it, replay is safe,
expired business rows and their related records survive actual TTL passes, and
ephemeral shares still expire. Observe every new regression fail before correction
or through a meaningful perturbation. Preserve fixture safety guards and do not
claim independent CH-* acceptance.

Release procedure: quiesce old application instances capable of recreating the old
index. From this release, inspect the migration dry run, explicitly apply and verify
against the intended database, then start the retired schema and recheck indexes.
This session runs only on owned disposable databases. Do not restart the old schema
after migration: it can recreate the TTL index. Already deleted rows cannot be
recovered by removing an index.

## Three audits and negative evidence

1. Feature audit: the schema no longer accepts expiry or declares any business
   TTL index. The migration uses the actual Document collection, disables automatic
   model/index creation, discovers custom names, preserves normal indexes on the
   same key and refuses unexpected TTL key patterns before mutation. No records
   are rewritten. Both schema regressions were red on the original model.
2. Platform audit: reviewed all eleven registries above, the document facade and
   callers, danger-zone custom executor/campus relations, deletedAt helper,
   retention cron, DocumentShare TTL, fixture index creation and the GED client
   form/service/hook. No expiry UI or provider contract needs changing. The general
   raw DTO assignment defect remains explicitly open in CLAUDE §5.2 and course
   finding ㊷. The course's old live-schema assertion was observed red, then its
   prose and executable check were updated together.
3. Test audit: all 14 new Jest cases have negative evidence. Nine migration
   perturbations cover dry-run mutation, skipped application, nonzero TTL,
   unexpected key patterns, missing namespace, metadata denial, DDL failure,
   concurrent removal and failed final verification. Removing the operational
   share TTL makes its preservation regression fail. Correct code is restored
   after each run. The real test independently checks raw row/index equality,
   at least two TTL passes and actual share removal; its negative replay
   reintroduces the old index only in memory and fails on missing business rows
   after the pass counter and share-expiry assertions succeed. Synthetic shares
   use the actual tokenHash field; enum values and the trash marker use shared
   definitions. The final check also invokes the actual dry-run and --apply CLI
   from an empty owned directory, with only its disposable URI as the database.

## Evidence and remaining work

| Check on 2026-10-16 | Result |
|---|---|
| Focused Jest | 14/14 PASS; all cases have negative evidence |
| Full Jest | 86 suites / 1,696 tests PASS, exit 0 |
| Backend lint | No errors; 40 existing warnings |
| Dependency gate | PASS; two existing named exceptions unchanged |
| Fixture self-check | 36/36 PASS; schema/index change preserves reproducibility and guards |
| Complete course | 67/67 executable solutions PASS; 14 declared skips; references PASS |
| ERP locales | 190 combinations PASS; no catalog/source change |
| Real TTL and actual CLI | 12/12 PASS, exit 0; dry-run, --apply, replay and active TTL checked |
| ERP build | PASS; existing bundle-size warning; output isolated under /tmp |
| Complete browser / screenshots | 174/174 PASS, natural exit 0; both themes and global/scoped roles inspected |

Local logs: `/tmp/ged-expiry-*.log`. The sandbox refused local sockets and the
audit subprocess; authorized validation replays outside that restriction are
reported above. No production database or existing container was touched.
The default Python run is exercised by the course guard; no separate AI/provider
integration replay is required for this backend-only schema/index retirement.
The general API journey is unchanged; fixture self-check and the dedicated TTL
acceptance cover the changed model here. Row 14 source delivery and local
acceptance are complete. Existing-database index rollout remains a mandatory
operator action on release. Browser artifacts are under `/tmp/ged-expiry-visual`;
reviewed captures include administrator/manager results in light/dark themes,
manager dashboard/finance and scoped AI read-only controls. Existing browser
checks also verify GED campus lists, document workflow reasons and authorized
citation drawers. No consumer source or environment contract changed.

Coordinated course commit: `955b796` (local only). Documentation links,
whitespace, generated course hooks and tracking visibility pass.
Row 4 target SLOs, CH-0 independent acceptance and administrator acceptance remain
with their owning work items. No later phase begins.
