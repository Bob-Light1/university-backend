# Current task and handoff

Last updated: 2026-09-19.
Status: IMPLEMENTATION COMPLETE — release validation blocked by existing gates.
Branch: `feat/fee-receipts-and-reminders`.

## Objective and approved decisions

Implement the owner-approved [design](architecture/features/product-home-and-branding.md).
The ERP home is a professional software showcase, separate from applicant intake:
light institutional design, three local synthetic preview tabs, ten locales,
external configurable sales contact and deployment branding. Wewigo is the default.
Preserve establishment/campus identity and the legacy registration referral redirect.

## Completed work

- ERP: new home/public shell, preview, FAQ, role benefits, one footer, ten home
  catalogs, local anonymous language persistence, shared name/logo fallback,
  browser/build metadata, login/activation/workspace identity and environment sample.
- Backend: configurable Excel creator and notification brand, explicit sender,
  HTML escaping, two regression suites and browser checks in the existing harness.
- Portal: shared identity, optional logo/icon, metadata/manifest and deployment
  sample; existing institutional overrides and all intake flows remain intact.
- AI: inspected; no user-facing commercial identity, so no code change required.
- Engineering map, feature note, roadmap presentation follow-up, deployment
  examples and affected course measurements updated. No phases reordered.

## Verification

Full backend: 73 suites / 1571 tests passed. Backend lint: 0 errors, 42 existing
warnings. ERP and portal production builds passed in the previous turn; no runtime
source changed since those builds. Portal lint and all 190 ERP locale/namespace
checks passed. New ERP components lint clean; nine errors in touched legacy files
were reproduced against HEAD.

Final browser QA: 90/90 passed, including 32 home checks, multiple roles, light/dark
themes, enabled/read-only/hidden modules and actual PDF downloads. The packaged
Chromium failed to start during the first run; using the existing supported
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome setting resolved that environment
failure. Custom brand, missing logo, sales URL, login and activation passed.
Portal default/custom/establishment precedence passed. Screenshots visually reviewed.

All five new unit tests were deliberately made red with compiled-input mutations,
then passed against the original sources. Course: 67/67 executable solutions pass,
14 illustrative snippets skipped, all references resolve. No CH-* item is closed.

Evidence: ignored logs in `tests/fixtures/.generated/product-home-validation/` and
screenshots in `tests/fixtures/.generated/visual/`. Do not publish generated fixture
credentials. Temporary QA processes were stopped after their reports.

## Remaining limitations and next action

The required dependency audit fails on seven unaccepted advisories in existing
extract-zip, js-yaml, nodemailer and sharp dependencies (0 critical, 6 high and 5
moderate reported overall). Dependencies/lockfiles were not changed or exceptions
weakened. Existing ERP lint errors remain. Details and advisory IDs are in the
[feature note](architecture/features/product-home-and-branding.md#remaining-release-gates).
These gates prevent declaring full release readiness; the homepage implementation
and its functional QA are complete. Treat any dependency-remediation work as a
separate scoped change, not an already approved roadmap decision.

The normal ERP dev server was started on http://127.0.0.1:5173/ for review. Check
that it is still running after a new session. No deployment or commit was made.

## Existing changes preserved

Backend `.gitignore`, `CLAUDE.md`, `tests/fixtures/visual.js` and untracked context
files/AGENTS.md predate this task. Frontend EntitlementDialog.jsx,
useEntitlementPilot.js and ParentDashboard.jsx also predate this task. The visual
harness has substantial user changes; only the home hook and reliable Chrome launch
were added by this task. Course is its own nested Git repository. Preserve all
these unrelated changes; no commit was requested.
