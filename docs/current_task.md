# Current task and handoff

Last updated: 2026-09-19.
Status: COMPLETED — backend-only branding CI fix; targeted validation passed.
Branch observed: `feat/fee-receipts-and-reminders`.

## Objective and changes

Fix the GitHub CI failure caused by `tests/unit/product-brand.test.js` loading
`../frontend/src/config/brand.js`, which is absent from a backend-only checkout.
Removed the filesystem/VM loader and the frontend-specific assertion. The suite
now tests the real backend brand configuration, including blank/unset product
names and whitespace-only establishment overrides, and retains the real XLSX test.
No resolver was copied into the tests, no production behavior changed, and no
second repository checkout or token was added to the workflow.

Affected files:
- `tests/unit/product-brand.test.js`: backend-owned behavior only.
- `docs/architecture/features/product-home-and-branding.md`: clarify that frontend
  URL validation is no longer covered by this backend unit suite.
- `docs/current_task.md`: current objective and verification evidence.

## Verification

Exported tracked HEAD into `/tmp/backend-brand-ci-check`, without a sibling
frontend; only installed backend dependencies are linked from the working tree.
The original targeted suite reproduced the exact ENOENT for
`/tmp/frontend/src/config/brand.js` (one failure, two passes).
Copied the corrected test into that isolated checkout: all six targeted tests
passed without a frontend checkout.
Backend lint passed with zero errors and 42 existing warnings.
The sandbox blocked a full-suite HTTP listener with EPERM. The full-suite retry
outside the sandbox was manually interrupted after about ten minutes without a
summary (exit 130); the full suite is not claimed as passing. Targeted validation
completed independently. Whitespace, tracked-file and handoff-link checks passed.

## Preserved release gates and scope

The working tree was clean at the start. No frontend, portal, AI, dependency,
workflow or production-code changes were needed. No commit or push was made.
The existing dependency-audit and frontend-lint release gates remain documented in
[the branding design](architecture/features/product-home-and-branding.md#remaining-release-gates);
they were not retested or remediated here. No CH-* item or product phase changed.

## Next action

The patch is ready for review and commit; GitHub CI has not been rerun remotely.
A complete-suite result remains unverified locally. Frontend resolver coverage
belongs in the frontend repository; introducing its test infrastructure is outside
this targeted backend CI repair.
