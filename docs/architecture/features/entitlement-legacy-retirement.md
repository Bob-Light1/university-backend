# Campus entitlement legacy retirement

Started: 2026-10-04. Updated: 2026-10-05. Status: delivered — phase 1-B row 2.

## Problem and scope

Phase 1-B row 2 previously retained two configuration fields and an unused AI administration
route after the unified entitlement UI replaced them. The existing browser harness
already covers parent, mentor and staff navigation, route guards and the §4.1.2
administrator guarantees. The pre-retirement replay passed 126/126 before schema and route retirement.

Bricks: backend implementation and fixture; ERP mentor workspace/shortcut guards and build.
No live database migration, record deletion, deployment, pricing or phase 2 work.
CH-0 remains pending independent acceptance under QA D-14.

## Contract and invariants

- Remove writable Campus schema paths `features` and `aiEntitlement`, and
  `GET|PUT /api/admin/campuses/:id/ai-entitlement`. The unified GET/PATCH endpoint
  remains the administration contract. AI gate/S2S payloads remain unchanged.
- Retain historical `aiEntitlementAudit` with `select: false`. The unified admin
  response must expose both ledgers, ordered newest first and limited to 20.
  Historical AI changes are wrapped in `changes.ai` for the existing renderer,
  preserving the complete original payload without rewriting stored rows.
  No historical audit entry or stored legacy configuration is erased.
- Keep the raw-driver migration and explicit lean compatibility reads for old
  databases. Removing writable schema paths does not authorize dropping saved
  configuration or changing the existing legacy fold and fail-open decisions.
- Seed unified entitlements through the existing fold with the fixture clock,
  preserving each campus's effective modules, quotas and AI behavior.
- Campus identity, ownership, deletion conventions and the feature registry
  remain unchanged. Campus is the tenant root; mutations use the existing
  administrator/campus authorization and entitlement service.

## Registry review

| Registry | Outcome |
|---|---|
| `app.js` | Same mounts; retired paths removed from the admin router |
| Module facades | Remove unused AI-only audit reader and legacy setter; retain the AI gate reader and unified administration |
| Feature constants | No new keys, states, plans or quotas |
| Hard-delete registry | No new entities, relations or deletion behavior; stored legacy data is retained |
| Soft-delete overrides | No marker or convention changes |
| Jobs | No new job or emission rule |
| Fixture counts | Same 307 documents / 39 seeded collections; configuration uses the shared legacy fold with frozen time |
| Translation catalogs | Reuse the translated refusal and AI audit label in all ten locales |
| Frontend service/navigation | No active legacy API client; mentor workspace and dashboard shortcuts reuse the existing shared guards |
| Course references | Recheck structural census and removed facade functions; synchronize affected lessons without weakening assertions |
| CLAUDE engineering map | Correct the stale AI storage description and document retirement once verified |

## Definition of done

Pre-retirement browser checks pass, including rendered parent/mentor/staff and
administrator access while a module is hidden. Schema and retired-route regression
checks, audit preservation, legacy migration compatibility and fixture behavior
are exercised. New checks are observed failing before the relevant change.
Complete code/platform/test audits; run Jest, lint, dependency audit, fixture
self-check, API journey, course checks and a current frontend build. Replay browser
QA after implementation and inspect screenshots in both themes. Update the roadmap,
canonical entitlement note, engineering map and handoff with actual evidence.

## Findings and validation

- Inspection: the unified admin GET currently returns only `entitlementAudit`;
  removing the legacy endpoint would make earlier AI decisions inaccessible there.
  The initial regression suite demonstrated the missing history before the fix.
- Initial browser launch was blocked by sandbox socket restrictions; replay uses
  the authorized local disposable-database harness outside that restriction.
- New regression suite observed six failures before changes (schema, two route
  handlers and three audit checks); fixture regression observed one failure.
- The initial browser run encountered resource saturation during concurrent
  compilation and tests. The owned build was stopped; repeat heavyweight checks
  sequentially. Do not treat those timing failures as confirmed product defects.
- The hidden mentor workspace showed a generic dashboard loading error; the old
  assertion only excluded raw 403 text and passed. Require the translated refusal
  instead and compose the existing feature guard inside the mentor role guard.
  Parent, mentor and staff portal checks now run in both themes.
- The first expanded-theme replay exhausted the fixture's login limiter by
  signing in twice per portal. Reuse one session per portal across the two
  themes; keep the production limiter unchanged. The pre-retirement replay passed after session reuse; final replay remains required.
- Screenshot inspection found the initial nominal dark portal capture was light:
  AuthContext restores the saved account preference after sign-in. The pixel
  luminance assertion was observed failing on that capture. Reuse `setTheme()`
  through `/api/settings` and check actual rendered luminance for each portal
  and theme. Initial menu/route checks alone do not establish theme coverage.
- The 2026-10-05 dependency gate reproduces GHSA-vfj7-8cjw-p6xm through
  `nodemon → chokidar → braces`. The registry and
  [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  report no patched braces version; nodemon 3.1.14 still carries the path.
  Replace the development-only watcher with Node 20's native `--watch` mode,
  preserving console output. Remove unused `nodemon.json` and verify actual
  dependency-file restart and SIGTERM cleanup. No new audit exception.

## Three audits against this note

| Audit | Findings and closure evidence |
|---|---|
| Feature code (§12 step 6) | Both ledgers must remain accessible through unified administration: initial retirement regressions failed six checks, now fixed. Schema retirement removes Mongoose legacy accessors: four hydrated capacity regressions fail without `toObject()`. No new scope, deletion or role policy is introduced. |
| Platform (§12 step 7) | The fixture must use the unified schema without changing its effective offer: one regression failed before the shared-clock fold. Disposable MongoDB validates the lean AI read, hydrated student quota, first-write fold and saved historical audit. Dependency gate failed on braces; removal of the development-only watcher closes that path without an exception. Native watch restart/SIGTERM passes and fails when watch mode is removed. |
| Tests (§12 step 8) | Mentor shortcut visibility failed in the focused browser replay before FeatureGate; the hidden mentor assertion previously accepted a generic loading error; archived screenshots reproduce it. Nominal dark portal screenshots were light: the luminance regression failed. Persist account themes and assert rendered luminance. Removing the unified GET role guard makes all four scoped-role regressions fail. Course census assertions fail on retired helpers and changed source counts; synchronize exact figures rather than relaxing checks. |

Every new Jest check has a corresponding pre-fix or deliberate-failure replay.
The legacy class-capacity query's existing `campus`/`schoolCampus` mismatch is
already documented by course lesson 05.2; this retirement preserves that query
and does not claim to fix the separate quota-policy work item (roadmap row 15).

## Validation ledger

Private replay artifacts live in ignored `tests/fixtures/.generated/row2/`;
fixture account files and generated credentials are never added to documentation.

| Check | Current result (2026-10-05) |
|---|---|
| Pre-retirement browser replay | PASS, 126/126; `pre-retirement-2026-10-05.log` |
| Regression proof | `red.log`, `fixture-red.log`, `quota-red-all.log` (4 failures), `authorization-red.log` (4 failures), `watch-red-confirmed.log` (restart missing), `theme-red.log` (dark capture was light) |
| Fixture self-check | PASS, 36/36; `self-check-final.log` |
| Real API/data journey | PASS, 25/25; `journey-final.log` |
| Backend lint | PASS, 0 errors / 40 existing warnings; `lint-with-shortcuts.log` |
| Dependency gate | PASS after lock synchronization and offline pruning; `audit-final.log`; 22 exclusive packages removed, no added or changed retained package version |
| Frontend build | PASS after the shortcut correction, current loopback API build in `/tmp/roadmap-row2-frontend-dist-2026-10-05`; standard chunk-size warning |
| Frontend touched-file lint/localization | PASS; `/tmp/roadmap-row2-frontend-lint-final.log` (one existing unused-disable warning), `/tmp/roadmap-row2-locales-final.log`; no new translation key |
| Complete Jest | PASS, 80 suites / 1,634 tests; `jest-green.log` |
| Course solutions and reference map | PASS, 67/67 executable solutions / 14 documented snippets; `course-with-shortcuts.log` |
| Final browser and screenshot inspection | PASS, 134/134; `browser-with-shortcuts.log`, screenshots under `final-with-shortcuts-2026-10-05/` inspected |

Heavyweight runs are sequential. Earlier environment/socket/resource failures
and interrupted builds do not count as successful checks. The first complete
Jest replay found an incorrect constant import in the new fixture test (1 failure
out of 1,634); the import was corrected and the complete replay passed.

- Final screenshot inspection found an ungated Courses shortcut on the mentor
  dashboard although the drawer and route were correctly guarded. The focused
  disposable-database browser replay using the durable shortcut assertion failed
  (`mentor-shortcuts-red-confirmed.log`, 0/1). Compose the shared `FeatureGate`
  around Results/Courses shortcut grid items; keep read-only history reachable.
  The same shortcut assertion passes in both themes on the rebuilt consumer.
  The final 134/134 replay closes the finding; the intermediate 132/132 run did
  not close it.


## Delivery

All applicable §12 checks pass, the three audits and eleven-registry review are
complete, and screenshots were inspected: parent/mentor/staff in both themes,
mentor refusal, read-only campus results, dark student finance and the global
administrator estate matrix. Mentor Courses is absent while Results remains
available under read-only. The browser compares actual saved theme preferences,
not only local storage hints. Relative documentation links, reference map,
whitespace and Git-ignore checks pass; generated accounts/logs remain ignored.

Roadmap row 2 is `LIVRÉ`; phase 1-B stays `EN COURS`. CH-0 acceptance under D-14,
earlier administrator acceptance and the separately recorded class-quota defect
remain open under their owning work items. No live data migration, deployment,
remote publication or phase 2 implementation is included. Effort/commercial
estimates retain their existing dated baseline; this delivery does not replan them.
