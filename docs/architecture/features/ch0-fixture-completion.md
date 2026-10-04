# CH-0 fixture completion

Date: 2026-10-02. Updated: 2026-10-04. Owner: Codex. Status: implementation complete and locally validated;
second-person acceptance remains required by QA_TEST_STRATEGY.md §12.3 / D-14.

## Problem and scope

Phase 1-B row 1 of [the roadmap](../ERP_ROADMAP.md) requires eight missing
collections in the deterministic fixture. Add synthetic data for both campuses
to GaetConstraint, Notification, UserPreferences, PrintJob, FinalTranscript,
DocumentVersion, DocumentShare and DocumentTemplate. Verify volumes, ownership,
references and repeatability. Keep the existing accounts and deletion traps.
Public-portal data, canonical CH-4 journeys and production changes are outside
this work item. This is fixture infrastructure, not a new product feature.

Only B1 changes. B2 consumes the fixture through the existing browser harness;
its build must be checked for compatibility. No B3/B4 API or environment changes.

## Data contract

Counts belong in `tests/fixtures/seed.config.js`; IDs and dates use the existing
business-key and frozen-clock helpers. Existing schemas and enum constants remain
authoritative. The fixture model loader remains the sole model-access mechanism.
Campus scope uses the actual schema: `schoolCampus` on GAET, notifications and
transcripts; `campusId` on preferences, print jobs and the GED family. Preferences
and notifications also reference their owning student. GED versions and shares
reference a document in the same campus. Draft transcripts reference the student's
class. GAET constraints reference an existing class, teacher and subject.

These eight models have no soft-delete marker. Existing deletion examples still
use `ctx.softDelete()`. No business deletion or danger-zone contract changes.
Entitlement remains inherited from the existing modules; no new key or plan.

Print jobs use a terminal state without generated files; notifications are in-app
only. Versions capture synthetic metadata; templates contain synthetic text,
with no external assets.
Draft transcripts exercise persistence and ownership, not semester aggregation.
Every nested GAET identifier and generated timestamp must be explicit.

## Frozen time and database execution

PrintJob and DocumentShare have TTL indexes. A frozen historical fixture would
otherwise disappear as the real clock advances. Disable the TTL monitor only on
the owned disposable replica set, while preserving the schemas and their indexes.
The seed must reject TTL-enabled servers before inserting these frozen records;
it must never reconfigure a caller-provided server. Test database URI and production
guards remain mandatory. This does not address the production GED TTL defect in
phase 1-B row 14, and does not constitute TTL testing.

Use the existing MongoMemoryReplSet implementation for the fixture CI check,
with a cached binary and tmpfs data directory. CH-2's future database choice D-06
remains open until that work item starts, as required by QA §4.11.

## Registry review and acceptance

Review all eleven registries from CLAUDE.md §12.5 before closing the implementation.
Required proofs: focused unit checks; real disposable self-check including mutation
tests of verification; complete Jest, lint and dependency gate; existing API journey
and browser harness on the expanded fixture; course checks for the added structure.
Report actual results separately from historical evidence. Update both dashboards,
the engineering map and the handoff. CH-0 stays `EN COURS — en attente de recette`
until a second person reviews the dataset and signs its acceptance.

## Eleven-registry review

| Registry | Result |
|---|---|
| `app.js` | No API or mount change; fixture uses the existing real app. |
| Module facades | No new exports; existing fixture loader resolves registered models. |
| Feature registry | No change; transcripts are already result records; other added rows inherit existing module keys. |
| Hard-delete registry | All eight models already have campus cleanup relations; transcripts also block student/class removal. No declaration needed. |
| Soft-delete overrides | No new convention; none of these eight models has a deletion marker. |
| Job registration | No new job; in-app notices and cancelled print jobs cannot trigger external delivery or printing. |
| Fixture `COUNTS` | Eight totals added per campus: two each on A, one each on B. |
| Localization catalogs | No product text or catalog changes; synthetic fixture content only. |
| Frontend services/navigation | No contract change; existing service and feature guards retained. Browser regression required. |
| Course hooks | No referenced path moved; course checks required for the two added builders. |
| Engineering map | §§1/9/10/11 remain accurate; §11ter updated for volumes, coverage and TTL prerequisites. |

## Audits and regression evidence

1. Fixture code: checked model validation, stable nested IDs, explicit timestamps,
   campus fields, document version numbers and reference ownership against this note.
   Seed validation now also protects programmatic callers before purge. The self-check
   proves production and TTL refusal preserve a sentinel document.
2. Platform interactions: reviewed entitlement record guards, danger-zone dependencies,
   workers, and TTL indexes. TTL monitoring is disabled on the owned disposable server
   only; an externally supplied server is inspected and refused, never reconfigured.
   Production GED TTL remains a separate open roadmap item. No new API consumer.
3. Tests: all nine new Jest cases failed before the builders were added, then passed.
   Self-check deletes one row in each added collection and corrupts eight scope/owner
   relationships plus two worker-channel states, requiring each targeted rejection.
   Each mutation is restored and verification reruns. The database digest covers all
   persisted defaults, not only the raw builder objects.

The dependency audit revealed pre-existing advisory
[GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r)
in `basic-ftp@5.3.1` through Puppeteer's proxy dependency chain. A scoped
`get-uri` override installs `basic-ftp@6.2.1`; only that lockfile package changes.
Node 20/CommonJS compatibility is verified by a real loopback FTP listing fallback
and file download through get-uri. The first test peer used a Unix listing without
a machine-readable modification timestamp, which get-uri rejects by design; the
corrected peer sends RFC 3659 metadata. The dependency gate passes with the same
two existing extract-zip exceptions and no new exception.


## Validation record — 2026-10-02 and 2026-10-04

| Check | Result |
|---|---|
| Fixture baseline before expansion | 16/16 checks; 283 documents / 31 collections |
| Expansion regression | Nine new cases observed failing before implementation, then passing |
| Final disposable self-check | 36/36, including refusal before purge, missing rows, ownership mutations and nine real logins; first seed 5.9 s |
| Complete Jest suite after dependency fix | 78 suites / 1,620 tests PASS |
| Lint | PASS on 2026-10-04: zero errors, 40 existing warnings |
| Dependency audit | PASS with the same two documented exceptions |
| API journey | 21/21 PASS on the expanded fixture |
| Frontend build | PASS in `/tmp/roadmap-ch0-frontend-dist`, using the loopback API; existing bundle-size warning |
| Course F2.1 | 58/58 PASS after synchronizing fixture counts; author review pending |
| Course references | PASS on 2026-10-04; generated reference map unchanged |
| Complete course replay | 67/67 executable solutions PASS on 2026-10-04; 14 illustrative snippets intentionally skipped |
| Complete browser replay | 114/114 PASS, exit 0 on 2026-10-04, with local Chrome configured for the PDF engine |
| Workflow syntax | Parsed successfully; remote GitHub Actions run not performed |

The initial browser run passed 110/112 evaluated checks: two receipt downloads
produced no file, leaving PDF-content/name checks unevaluated. A warm direct API
diagnostic returned HTTP 200, `application/pdf`, 48,748 bytes and `%PDF-` in 264 ms.
The supported `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome` configuration
makes both receipt downloads pass. This is environment configuration; no product
PDF fix is claimed, and the 20 s receipt deadline is unchanged.

The next complete run passed 113/114: its estate screenshot still showed
`Loading...`. Replace the fixed 3.5 s sleep after `networkidle2` with a bounded
wait for campus data (20 s); retain the existing campus/entitlement assertion.
The final tracked replay passes 114/114 and exits 0. Interrupted attempts provide
no complete-run acceptance evidence. Captures were inspected for student and
campus-manager screens in both themes, the frozen-state banner, and the populated
administrator estate. No additional visual defect was found in those surfaces.

Private logs are retained in ignored `tests/fixtures/.generated/ch0/evidence/`;
browser captures are under the adjacent visual directories. These artifacts use
synthetic data and are not committed. No frontend source changes were required. The temporary 2026-10-02 frontend build
was removed between sessions; a fresh 2026-10-04 build passed in 3 m 16 s and was
moved to `/tmp/roadmap-ch0-frontend-dist-2026-10-04` before course replay to keep
compiled JavaScript outside source censuses.

Course validation exposed existing snapshot drift in 18.1 and F2.2/F2.4/F2.5.
Their exact count assertions, measured prose and four PartnerForm enumeration
locations are synchronized; prior edits in those files are retained. F2.2 now
counts five HTTP suites separately from PDF/FTP integration checks. F2.4 passes
57/57. F2.3 passed 83/83 when run directly after the build, establishing that its
full-run failure was transient rather than a failing source assertion. The final
full-course replay passes all 67 executable solutions, including 51/51 F2.2 checks,
83/83 F2.3 checks and 41/41 F2.5 checks. Course version is 2.17.5; affected lessons
are marked for author review. Historical perturbation measurements remain dated.

## Acceptance boundaries

The implementation does not close CH-0. QA §12.3 / D-14 still requires another
person to review the §4.3 volumes against `seed.config.js`, execute the self-check
and sign the dashboard. CH-2's D-06, canonical CH-4 journeys, CH-5, production GED
TTL and the prior administrator acceptance remain in their owning work items.
