# Current task and handoff

Last updated: 2026-10-09.
Status: COMPLETED — phase 1-B row 3, authentication session hardening.
Backend branch: `main`; starting commit: `8c6cfa4`; initially clean.

## Objective and delivered changes

Continue the approved phase 1-B authentication row. The canonical
[session note](architecture/features/auth-session-hardening.md) owns the contract,
three audits, eleven registries, validation and release limits.

- Account session/lock models and persistence; five session routes; all eight
  login controllers (nine roles), shared authentication and admin bootstrap.
- Short access tokens, rotating refresh cookies, revocation and account-wide
  lockout; authoritative actor/campus claims and danger-zone cascades.
- ERP client lifecycle, reload/logout, Axios/SSE and remaining API consumers;
  late failures cannot clear a newer login or retry under a different actor.
- Expand-only collection/index preparation and permanent authentication journey
  in the existing fixture CI job. Three security patch upgrades; no new exception.
- Engineering maps, roadmap row, QA maintenance record and course 2.17.7 updated.

## Checks performed on 2026-10-09

Full Jest: 82 suites / 1,673 tests. Final client transport: 8/8. All 38 new targeted
cases observed red with meaningful perturbations or pre-fix regressions.
Authentication journey: 78/78; fixture self-check: 36/36; existing journey: 25/25;
fixture CI wiring replay: 25/25. Backend lint: no errors, 40 existing warnings.
Dependency gate passes with its two existing named exceptions. Actual image
resize/storage and proxy trust checks pass. Frontend build, touched lint and
190 locale/namespace combinations pass. Complete browser QA: 146/146; final-build
authentication replay: 12/12, administrator/manager in both themes. Screenshots
inspected. Course: 67/67 executable solutions, 14 snippets skipped, references
current. Logs: `/tmp/row3-checks`; final SPA: `/tmp/row3-frontend-dist-current`.

## Remaining boundaries and next action

No implementation work remains for row 3. Conventional local commits coordinate
backend, ERP client and separate course repository; no push or deployment.
Release preparation and legacy-token fresh login are documented in the session
note. Browser Web Locks fallback and existing partner reset delivery limitations
are recorded there. CH-0 independent acceptance (QA D-14), earlier administrator
acceptance and the separate GED TTL defect remain with their owning work items.
Phase 1-B is still in progress; follow-up recommendations do not authorize another
row or phase. Continue only with the owner's next instruction.
