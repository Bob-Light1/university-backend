# Current task and handoff

Last updated: 2026-09-19.
Status: COMPLETED — dependency audit remediation and validation.
Branch observed: `feat/fee-receipts-and-reminders`.

## Objective and changes

Fix the next GitHub CI failure, now in the security audit after the branding tests
passed. The initial audit reproduced seven blocking root advisories, not only sharp.

- `package.json` / `package-lock.json`: sharp 0.35.3 → 0.35.4 (libheif 1.23.2),
  nodemailer 9.0.5 → 9.1.1, transitive js-yaml 3.15.1 → 3.15.2 and 4.3.1 → 4.3.2.
  Existing overrides and dependency major versions are preserved.
- `scripts/audit-gate.js`: retain the original extract-zip exception unchanged and
  add a separate exact-ID exception for GHSA-7pqw-9j4j-h8q3, which has no patched
  release. The installed Puppeteer archive extractor is only called by its browser
  installer; both backend PDF services launch an explicit existing binary. No
  backend script or workflow invokes that downloader. Removal conditions are recorded.
- `tests/unit/audit-gate.test.js`: verify both named exceptions, rejection of sharp
  and unknown extract-zip advisories, and removal of stale exceptions.
- `CLAUDE.md` §8.1: update the count and rationale of named exceptions.
- `docs/architecture/features/product-home-and-branding.md`: record the resolved
  audit gate while preserving the remaining frontend lint release debt.

## Verification

- Initial `npm run audit:ci`: reproduced seven unaccepted root advisories.
- Updated `npm run audit:ci`: PASS, zero unaccepted advisories, two named exceptions.
  Raw totals remain 0 critical, 3 high, 5 moderate; this is not a zero-findings audit.
- Backend lint: zero errors, 42 existing warnings.
- Real runtime checks: passed PNG/JPEG uploads through GED storage, with 3200×1600
  images actually resized to 3000×1500 (detecting silent optimizer fallback), and
  Nodemailer MIME generation with a synthetic attachment using an offline transport.
- Isolated `npm ci --no-audit --no-fund`: PASS, 774 packages installed from the
  corrected lockfile in `/tmp/backend-security-clean-ci`.
- `npm ls sharp nodemailer js-yaml extract-zip --all`: PASS, resolved versions
  match the intended updates.
- Full Jest suite: PASS, 74 suites / 1579 tests, including five new audit-gate
  regression checks (296.852 seconds).
- Clean-install native versions: sharp 0.35.4, libheif 1.23.2, nodemailer 9.1.1.
- Final diff whitespace and local documentation references: PASS. The new test
  is visible as an untracked file and must be included in the eventual commit.

Logs and temporary checks are in `/tmp/backend-security-*`. Initial direct JSON
registry requests failed (DNS in the sandbox and a separate endpoint error outside);
the final audit gate fetched and evaluated a valid report successfully.

## Scope and remaining work

The working tree was clean at the start. No product/API contract, frontend, portal,
AI service or runtime major-version migration was changed. No commit or push made.
The earlier backend-only branding test repair is already in HEAD; the user reports
GitHub tests passed. Existing frontend lint debt remains in the branding design.

## Next action

Changes are ready for review and commit, including both package manifests and the
new regression test. No commit or push was requested or performed. GitHub CI has
not been rerun remotely. The two accepted extract-zip advisories and remaining
moderate findings are not fixed; their tracking and removal conditions remain.
