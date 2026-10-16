# Phase 1-B row 4 — AI operational acceptance

Started: 2026-10-09. Status: IN PROGRESS. Owner requested the next logical
phase 1-B work after authentication. Starting backend: `main`, `1eedf6f`, clean;
fact corrections committed separately as `5338343`. Local implementation and
acceptance completed on 2026-10-16; deployed-target acceptance remains open.

## Problem and scope

Existing AI screens and M0–M6 need current operational evidence. D2 is already
closed: preserve bge-m3/1024d and the recorded toy-corpus limitations. Verify the
ERP screens, fix demonstrated acceptance defects, extend the existing browser
harness, and measure actual generated text and completed SSE responses in the
load harness. Deployed-target latency acceptance remains required. No deployment,
new persona, provider purchase, embedding migration, pricing change or later
roadmap phase is included.

| Brick | Scope |
|---|---|
| Backend | Existing gateway, disposable browser act, regressions and evidence |
| ERP frontend | Existing administrator/campus AI screens; shared feature guards |
| AI service | Existing load harness, regression tests and security integration |
| Public portal | No contract or UI changes |

## Contract, campus, deletion and entitlement

Keep backend constants and AI design Annex B contracts. Node remains the public
gateway; actor and campus travel in signed S2S claims. Synthetic browser upstream
test doubles prove contracts and UI, not provider performance or retrieval.
Real pgvector/security checks are reported separately. Conversations remain
scoped to campus and actor. No deletion policy or model change.

Module key `ai`: enabled permits generation; read_only preserves GET history
and disables POST actions; hidden blocks scoped actors. Global roles retain
the established unrestricted policy. Reuse ten locale catalogs, theme preferences
and the session-aware SSE transport.

Browser Stop cancels the Node upstream through the response close lifecycle;
unfinished consumer EOF reports the existing translated STREAM error. GED document
citations use the campus document route and its authorized detail endpoint.

Load TTFT ignores metadata/keep-alive and requires nonempty delta text. Success
requires terminal done without error. Mint short-lived tokens at dispatch and
accept actor/profile/plan/budget configuration. Mock timings must be labeled as
overhead, never deployed-provider SLO proof.

## Eleven registries

| # | Registry | Reviewed change |
|---|---|---|
| 1 | app.js | None; existing gateway |
| 2 | Module facades | None; no public export |
| 3 | Feature constants | None; inherit ai |
| 4 | Hard-delete registry | None; no model/deletion change |
| 5 | Soft-delete strategies | None; existing helpers |
| 6 | Jobs | None |
| 7 | Fixture COUNTS | None; browser data stays in owned runtime |
| 8 | Catalogs | Reuse translated labels in all ten locales |
| 9 | Services/navigation | Existing routes; shared feature controls, SSE lifecycle and source-type mirror |
| 10 | Course hooks | No move; run structural guard |
| 11 | Engineering map | AI browser act and validation limits |

## Acceptance

Follow backend CLAUDE §12: build, meaningful regressions, feature/platform/test
audits, full backend checks, consumer build/lint/locales, real pgvector security
and browser QA in both themes with global/scoped roles and all module states.
New regressions must be observed red before correction or by meaningful
perturbation. No independent CH-* acceptance is claimed.

## Audits and regression evidence

Feature audit against this note: citation route selection now uses the backend-owned
source-type enum through the existing client mirror. A missing-mirror parity check
was red before adding the mirror. The old load harness timed metadata and accepted
HTTP-200 partial/error turns. Corrected parsing is exercised by 16 cases: eight
original failures and meaningful context/CLI/target/status perturbations cover all
new cases. The HTTP-status test initially used a done-only body, which could pass
through the completion guard without proving status rejection; it now supplies an
otherwise valid turn and fails when the status guard is removed.

Platform audit: scoped read-only screens exposed generation controls; document
citations pointed to a missing SPA route; Node listened to the already-completed
POST request's close event. Controls reuse useFeature; citations open an authorized
GED drawer and refuse another campus; SSE uses response close. The pre-fix browser
replay was red for read-only actions and GED links; the real HTTP disconnect
regression was red before the controller fix. Auth, entitlements, deletion,
aggregates, queues and all eleven registries retain their established contracts.

Test audit: an unfinished frontend stream did not call onError/onDone, leaving the
UI busy. Three original EOF cases failed before correction; deliberate dropped
terminal callbacks and a noisy explicit cancellation made the other three cases
fail. Browser response waiters select the actual POST rather than its CORS preflight.
History now clears the current answer, selects a unique scenario title and verifies
the fetched user message before asserting the rendered history; usage
asserts the returned count, and analytics compares response figures to independently
queried ERP aggregates and displayed nonzero numbers. A synthetic peer is not RAG,
Python integration or provider-performance evidence. A deliberate runtime mutation
of usage, signed identity, history content, ERP figures, feature states and service
availability made 24/28 AI browser cases fail; the other four GED navigation cases
were red on the original frontend. All new browser cases therefore have negative
evidence in addition to their correct-build replay.

## Checks on 2026-10-09

| Check | Current result |
|---|---|
| Full backend Jest | 84 suites / 1,681 tests PASS |
| Gateway disconnect regression | 1/1 PASS; observed red before correction |
| SPA SSE lifecycle and source enum | 7/7 PASS; all cases observed red |
| Backend lint | No errors; 40 pre-existing warnings |
| Dependency audit gate | PASS; existing named exceptions unchanged |
| ERP build, touched lint, locales | PASS; 190 locale/namespace combinations; existing bundle-size warning |
| Python | 173/173 PASS, including 15 real-database integration checks |
| Python lint and typing | ruff full tree PASS; mypy app/workers PASS (54 files) |
| Course | 67/67 complete PASS; 14 declared snippets skipped; links PASS; final enum inventory guard 57/57 PASS |
| Complete browser harness | Completed on 2026-10-16; see completion evidence below |

Real local Node/Python smoke passed against owned ephemeral MongoDB and an owned
pgvector container: readiness, eligible GED ingestion, scoped retrieval and current
citation authorization, terminal SSE, persisted two-message history, cross-campus
404, token usage, ERP analytics/advisors, ten chat requests at concurrency two,
and refusal of target mode against mock providers. An initial smoke selected a
published but non-indexable document; corrected selection uses the document facade's
eligible nonempty feed. Resource-heavy Jest, build and Chrome checks must be
sequenced on this 8 GB machine. Administrator browser selection now waits for the
visible translated button; network quiet alone did not prove a lazy screen was
rendered. Earlier missing-button checks were red before this harness correction.
Interrupted and concurrent runs are not acceptance passes.

Providers and embeddings were mock; measured TTFT/full
latencies are only protocol/service overhead, never an SLO result.

Evidence logs are local under `/tmp/row4-checks`; browser images are ignored runtime
artifacts under `tests/fixtures/.generated/visual`. Generated accounts and secrets
are excluded from tracked evidence. No fixture COUNTS, model, dependency or public
portal changes. Fixture self-check and general API journey are not rerun because
seed data and that journey did not change; prior row-3 results remain historical.

## Completion replay on 2026-10-15–16

Working trees match the implementation recorded above. Temporary October 9 logs
and build artifacts had been cleared; historical results above retain their date.
The unchanged ERP source was rebuilt successfully, touched frontend lint passes
and 190 locale/namespace combinations pass. The final browser run passes 174/174,
including all 28 AI cases. Screenshots
were inspected for chat, actual ERP figures, read-only controls, hidden-module
refusal and disabled service, across administrator/manager identities and both
themes. The frozen student finance screenshot also confirms the actual ledger
and payment rows after the generic quota correction.

The replay exposed a fixture environment mismatch: browser UI used installed
Chrome while backend PDF pools fell back to serverless Chromium and timed out
waiting for its WebSocket endpoint. The fixture now sets the existing
PUPPETEER_EXECUTABLE_PATH to the same installed binary. A direct real render
produces a valid 18,154-byte PDF in approximately ten seconds. No PDF application
service or production defaults changed. The receipt helper
also used a 20-second filesystem wait while the SPA explicitly allows 90 seconds
for binary exports; the harness now uses that existing budget. Completed-file,
PDF bytes, filename, ownership and read-only assertions remain required. The first
completion replay passed all 28 AI cases and 173/174 overall; the second receipt
failed. Receipt actions now use a real pointer click rather than DOM.click, re-arm
downloads after navigation, and observe the actual read-only GET and PDF bytes.
Inspection of the failed freeze screenshot revealed an empty ledger with a
429: the harness had exhausted the generic 100-request API budget. Its existing
loopback reset now runs before fixture control calls and finance navigation;
production limits and per-user PDF limits are unchanged. Frozen-ledger assertions
require the actual payment buttons rather than only a page heading.
The corrected full replay passes 174/174, including both real receipt downloads.
A second complete replay with temporary exit diagnostics also passes 174/174 and
exits naturally with code 0 (`beforeExit` and `exit` both report 0). This confirms
process completion independently of the earlier execution session, which reported
SIGTERM (143) after printing its passing summary. The earlier signal's origin was
not established; no shutdown code changed. Diagnostics remain outside the tracked
source. Final log: `/tmp/row4-checks/visual-clean-exit.log`.

| Completion check | Result |
|---|---|
| Complete browser harness | 174/174 PASS; 28 AI cases; natural exit 0 confirmed; screenshots inspected |
| AI gateway/consumer regressions | 8/8 PASS |
| Backend lint | No errors; 40 pre-existing warnings |
| Dependency audit gate | PASS; two documented exceptions unchanged |
| ERP build, touched lint and locales | PASS; 190 combinations; existing bundle-size warning |
| Python lint/types | Full ruff PASS; mypy app/workers PASS (54 files) |
| Default Python run via the course guard | 158 PASS / 15 database skips, exit 0 |
| Full course | 67/67 executable solutions PASS; 14 declared snippets skipped; links PASS |

The complete backend run (84 suites / 1,681 cases), actual pgvector security run
(173 cases with all 15 integrations) and real-stack smoke above remain dated
2026-10-09. The application implementation is unchanged since the October 9 final
snapshot. Current targeted regressions also verify the consumer enum mirror.
The browser history check also identifies its unique role/theme conversation and
verifies the detail response, rather than selecting an earlier theme's first row.

The local Docker engine did not answer bounded image inspection on October 15
or the five-second recheck on October 16, so a fresh pgvector replay remains
unavailable in this environment. No existing container or
engine was restarted. The 15 actual pgvector integration checks and real-stack
smoke recorded on October 9 remain historical evidence on unchanged service code.

## Remaining target acceptance and next action

The owner confirms no target infrastructure exists and requests all possible local
preparation/validation. Keep roadmap row 4 IN PROGRESS. No deployment or provider
call was authorized. CH-0 independent acceptance and administrator acceptance remain
with their own work items; the separate GED TTL defect is not a deletion exception.

Once a target exists, use the recorded D4 hosting/provider decision, bge-m3/1024d,
a representative synthetic corpus and real synthetic ERP actors. Verify ingestion,
ERP reachability, readiness and selected provider; agree the request volume and
cost before executing. Supply the shared secret through AI_SERVICE_SECRET,
never command history or report files. Example protocol (not executed here):

```bash
python scripts/loadtest.py --target --url "$AI_TARGET_URL" \
  --scenario chat --campus "$AI_TEST_CAMPUS_ID" --user "$AI_TEST_ACTOR_ID" \
  --role "$AI_TEST_ROLE" --profile "$AI_TEST_PROFILE" --plan premium \
  --language fr -n 100 -c 5 --output chat-target.json
```

Record machine/container resources, service/model revisions, dataset size, cache
warmth, chosen profile, actors/campuses and workload next to the aggregate report.
Measure both configured profiles and a realistic campus distribution, including
hot-campus load (the existing usage upsert contention remains a known follow-up).
The design §10bis gates are search p95 ≤ 500 ms, chat generated-text TTFT p95 ≤ 2 s,
full response p95 ≤ 15 s and errors ≤ 0.5%. A green mock run or a tiny workload cannot
close these acceptance requirements.
