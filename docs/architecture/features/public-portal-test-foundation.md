# Phase 1-B row 13 — Public portal test foundation

Started: 2026-10-16; closed locally: 2026-10-17.
Status: SOURCE DELIVERY AND LOCAL ACCEPTANCE COMPLETE.
The owner requested continued phase 1-B work. Backend `main` starts clean at
`ffd6130`; the separate public portal is on clean `main`. Under roadmap §3,
row 13 precedes admission changes (row 5): protect the existing unauthenticated
funnel before adding dossier uploads and student conversion.

## Scope and bricks

Add a deterministic Vitest foundation and a blocking GitHub Actions workflow
in the public portal repository. Cover the actual Next.js handlers, ERP client,
campus resolution, referral attribution and failure paths. Add backend regression
coverage for the anti-fraud rules owned by the backend, rather than pretending
the portal implements them. Use synthetic requests and mocked network/persistence;
no provider, production data, deployment, admission policy or new UI.

| Brick | Change |
|---|---|
| Public portal | Test runner/configuration, regression suites, CI, developer instructions |
| Backend | Antifraud regressions, reusable owned-loopback portal browser QA, design/evidence and tracking |
| ERP frontend / AI service | No contract or runtime change |

## Contract, scope, deletion and entitlement

Preserve all routes and response envelopes. Pre-registration accepts HTTP 202
without a lead identifier; the honeypot receives a silent 200. The portal forwards
attribution, original visitor IP and quiz session tokens. Only the server proxy
attaches the portal key. Backend campus resolution remains authoritative; referral
resolution takes precedence over a submitted slug. Duplicate leads retain existing
partner attribution; IP bursts are flagged by the backend. No new model or deletion
policy. Inherit existing public-portal entitlement: hidden remains indistinguishable
from missing; read-only refuses submissions while reads remain available.

The workflow belongs at the portal repository root and checks main pushes and pull
requests without a fictitious monorepo path filter. Install from its own lockfile;
run lint, tests and a production build using local synthetic configuration.
No hosted secrets or deployed ERP are prerequisites. Keep the runner compatible
with the verified local Node runtime; record dependency audit evidence.

## Eleven registries

| # | Registry | Change |
|---|---|---|
| 1 | app.js | None; routes unchanged |
| 2 | Module facades | None; tests mock existing public surfaces |
| 3 | Feature constants | None; existing public-portal gate |
| 4 | Hard-delete registry | None; no new persistence |
| 5 | Soft-delete strategies | None; no marker changes |
| 6 | Jobs | None; ingestion behavior unchanged |
| 7 | Fixture COUNTS | None; no seed changes |
| 8 | Translation catalogs | None; no product text |
| 9 | Consumer services/navigation | Test existing portal client; no API change |
| 10 | Course hooks | No moves; synchronize F2 lessons/assertions with 87 backend and six portal suites; run reference/solution checks |
| 11 | Engineering map | Document portal test foundation and commands |

## Acceptance

Follow CLAUDE §12: write tests before the feature, platform and test audits;
prove each new case can fail through meaningful perturbations. Run portal tests,
lint, type/build checks and dependency audit; backend Jest, lint, audit and course
checks. Verify the workflow from a clean install. Inspect rendered portal pages
and the submission path with synthetic responses. Portal visitors are anonymous
and the portal has no account roles or theme toggle; existing ERP browser
acceptance remains the source for its two-role/two-theme and entitlement cases.
Any unavailable validation is an explicit delivery limitation.

This is row 13, not CH-2/CH-3/CH-4 delivery or independent CH-0 acceptance.
The row advances only with implementation; record actual evidence below.

## Audits and negative evidence

1. Feature audit: real Next Request/Response objects exercise the handlers and
   proxy, not a duplicated proxy implementation. Network is stubbed and unexpected
   fetch fails. The browser client accepts 202 without an identifier and forwards
   the served quiz token. Portal tests cover resolution/transport; the backend
   controller/service tests own antifraud behavior.
2. Platform audit: all eleven registries above are reviewed. The portal workflow
   targets its own repository root. The public API document incorrectly described
   a returned lead identifier: corrected to the actual 202/no-data contract, with
   the older live-verification date explicitly retained for other sections.
   No route, model, fixture or consumer runtime source is changed.
3. Test audit: 22 meaningful portal source perturbations make all 33 initial
   cases fail at least once; 10 backend perturbations cover all 12 backend cases.
   The refused-campus case initially missed a continuation after the helper had
   already answered. It now drains that continuation and checks both no ingestion
   and no next(error) after refusal; removing the return is detected. Six audit-gate
   perturbations make every gate test fail. All perturbed sources are restored.
   An isolated browser negative copy changes actual DOM state, browser headers,
   attribution payloads, upstream statuses and image responses; all 18 browser
   checks detect those faults. The committed positive harness is unchanged.
   Explicit test/configuration typechecking caught an inferred honeypot string;
   the payload now uses the existing PreRegisterPayload type. That check was red
   before the annotation fix and passes afterward.

The dependency gate was observed rejecting the actual unpatched dependency
report before transitive updates. Portal Next/eslint-config-next are patched
from 15.5.19 to 15.5.28; Sharp resolves to 0.35.5, js-yaml to 4.3.2 and both
brace-expansion branches to patched compatible releases. A PostCSS override
(`^8.5.23`, locked to 8.5.30) addresses Next's pinned vulnerable compiler chain.
Vitest 4.1.12 supports the existing Node 20 runtime; this task is not a runtime
migration. The separate backend dependency gate and its exceptions are unchanged.

Only the development lint glob chain retains
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), for
which upstream lists no patched braces release. The named portal exception has
its reason and removal condition in scripts/audit-gate.mjs; evaluation refuses
it if any affected installed node is not dev-only. Unknown high/critical roots,
stale exceptions and registry failures block CI. No broad audit bypass is used.

## Evidence and remaining work

| Check on 2026-10-16 | Result |
|---|---|
| Clean portal npm ci | PASS in isolated copy and actual portal checkout |
| Portal Vitest | 39/39, six files; actual checkout also passes |
| Portal production build | PASS, Next 15.5.28, 117 prerendered pages, eight locales |
| Portal explicit typecheck and lint | PASS in actual checkout; no lint errors/warnings |
| Backend Jest | 87/87 suites, 1,708/1,708 cases, final exit 0 |
| Backend lint | No errors; 40 pre-existing warnings; touched code clean |
| Dependency gates | PASS; one named dev-only portal exception, two existing backend exceptions |
| Portal browser harness | 18/18 PASS; screenshots inspected; all 18 negative faults detected |
| Course | 67/67 executable solutions, 14 declared skips; refreshed reference index passes |
| Complete ERP browser replay | 174/174 PASS, exit 0; final screenshots inspected across themes, global/scoped roles and entitlement states |

The portal browser harness is `npm run test:portal`; it requires a current built
portal (optional PORTAL_ROOT), local Chrome and backend browser dependencies.
It creates its own loopback ERP/Next processes, blocks outside browser traffic,
and generates a fresh server-only key. It uses synthetic ERP responses, not a
real API/database journey or deployed-provider acceptance. The existing ERP
browser harness retains the real owned database and authenticated role coverage.

Initial restricted backend/course runs hit socket/subprocess restrictions;
authorized replays resolve them. Heavy local disk/swap pressure caused a watched
process startup and browser/PDF timeouts. No thresholds were relaxed: the watched
process passes isolated, then the full backend passes 1,708/1,708. The portal
build/typecheck passes outside restricted workers. A generated course reference
index was refreshed after its stale-index check failed.

Logs and owned artifacts: /tmp/portal-*.log, /tmp/portal-*-mutations.json,
/tmp/portal-foundation-browser-permanent and /tmp/portal-foundation-erp-visual-final.
Coordinated local commits: portal `32118d0`, course `02274b5`.
The hosted GitHub workflow has not run: no push or deployment is performed.
Final ERP browser acceptance passes without changing timeouts; screenshots include
administrator/campus-manager, light/dark and enabled/read-only/hidden states.

Existing-database GED migration, unavailable AI target SLOs and independent CH-0
acceptance remain with their owning notes. Row 5 owner decisions (2026-10-16):
only DIRECTOR / ADMIN may pronounce
admission; the campus manager prepares the dossier. No automatic payment
prerequisite in this version. These decisions do not implement row 5.
