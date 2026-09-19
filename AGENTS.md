# Backend agent instructions

## Start and resume

- This repository is the backend of a multi-campus academic ERP, not a monorepo.
- At the start of a session, read [project context](docs/context.md) and [current task](docs/current_task.md) once.
- Check `git status --short` and the relevant diff before editing; preserve unrelated changes.
- Treat the handoff as a dated snapshot. Verify its branch, files and claims against the working tree.
- A completed handoff is historical context, not authorization to start its suggested follow-up.
- The user's current instructions determine scope. Recommendations are not approved product decisions.

## Read only what the task needs

- Start with the relevant module, its facade, callers and tests; widen the search when dependencies require it.
- Use `rg` and bounded excerpts. Avoid dumping entire directories, large logs or lockfiles into context.
- Do not reread documents already available in the session unless they changed or a missing detail matters.
- [CLAUDE.md](CLAUDE.md) remains the detailed engineering reference; consult the relevant sections below.
- Do not duplicate that reference here or load it in full for every task.
- These summaries supplement existing rules; omitted details are not waived. Follow any task-specific mandatory reading, including full-document reading when required.
- Product status belongs to `ERP_ROADMAP.md` §0 and its phase rows; QA work-item status belongs to `QA_TEST_STRATEGY.md` §0. The handoff and conversation summary do not replace them.
- Do not scan `node_modules/`, `uploads/` or generated artifacts unless the task specifically needs them.
- Report outcomes, checks and remaining limitations concisely; do not paste code already written to files.

## Engineering invariants

- Use module `index.js` facades for cross-module access; do not import another module's internals.
- Keep persistence in repositories, cross-document rules in services, and HTTP handling in controllers.
- Reuse shared helpers and exported constants; the backend defines API enums and error codes.
- Apply campus scope through existing helpers using authenticated identity, never an untrusted body campus.
- Most scoped models use `schoolCampus`; GED and several others use `campusId`, and `StaffRole` uses `campus`.
- Inspect the actual model and its scope helper before filtering; some collections are intentionally global.
- Partner reads also require partner ownership. Other self-service routes must enforce their own ownership rules.
- Derive archive/restore filters and patches from `shared/utils/soft-delete.js`; conventions differ by model.
- Permanent deletion of business records must use `shared/lib/hard-delete/`, including its guards, registry and audit trail. Preserve only the explicit exceptions in `CLAUDE.md` §5.2; do not treat the documented GED TTL defect as an exception.
- Entitlement controls commercial availability; it never replaces authentication, campus or ownership checks.
- Use `asyncHandler` and response helpers; validate inputs and preserve route-specific rate limiters.
- Declare named routes before `/:id`; mount public routes and authentication in the established order.
- All code, identifiers, comments, JSDoc, logs and documentation must be written in English.
- This language rule supersedes older allowances for French documentation in referenced project guides.
- Conversational replies should follow the user's language; repository documents must remain in English.
- Product translations remain in their target languages: preserve notification/PDF localization and the frontend's 10 locales (`CLAUDE.md` §12.2). The English authoring rule does not make the product English-only.
- Update every affected API consumer and its environment wiring in the same task, subject to workspace permissions; report blocked work and do not declare the feature delivered while a required consumer remains incomplete.
- Never publish secrets, real personal data, activation codes or generated fixture credentials in documentation.

## Detailed references by task

| Task | Read before implementing |
|---|---|
| Any code change | `CLAUDE.md` §§0–0.1 (language, JSDoc and DRY), then the applicable sections below |
| Controllers, models, validation, routes | `CLAUDE.md` §§1–8; backend validation is plain JavaScript, not Yup |
| Campus isolation or deletion | `CLAUDE.md` §§2, 5.1, 5.2 and the actual model/helpers |
| New feature or cross-repository change | `CLAUDE.md` §12, including registries and definition of done |
| Entitlement or offer changes | `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` and `shared/constants/features.constants.js` |
| Product planning or delivery status | `docs/architecture/ERP_ROADMAP.md` §§0, 3, 14 and the affected phase; preserve phase order and recorded decisions |
| Test infrastructure or fixture changes | `docs/architecture/QA_TEST_STRATEGY.md` reading order and §12.3 acceptance rules for CH-* work items; `CLAUDE.md` §11ter |
| AI, activation, licensing or migration | The corresponding design note linked from `docs/context.md`, including its decisions, reading requirements and handoff |
| Dependency upgrades | `CLAUDE.md` §8.1, `package.json` and `scripts/audit-gate.js` |
| Moving files referenced by the course | `CLAUDE.md` §11bis; `docs/cours/` is a separate repository |

## Validation

- Start with checks relevant to the change; retain all checks required by the applicable delivery workflow.
- For a code bug, reproduce it and add a meaningful regression check when appropriate.
- Full feature delivery follows `CLAUDE.md` §12; token savings do not waive its acceptance criteria.
- Preserve its ordered design/build/test/audit/browser-QA steps, eleven-registry review and regression evidence for audit findings. Course checks also apply to structural changes, not only file moves.
- Documentation-only changes need link, accuracy, whitespace and Git-tracking checks, not the application suite.
- Distinguish checks actually run from historical results, unexecuted commands and environment blockers.

| Command | Purpose / prerequisite |
|---|---|
| `npm test -- --runInBand --runTestsByPath tests/unit/<name>.test.js` | One relevant Jest suite; replace the placeholder |
| `npm test -- --runInBand` | Full Jest suite; distinct from real-database and browser harnesses |
| `npm run lint` | Backend lint |
| `npm run audit:ci` | Dependency audit gate; requires registry access |
| `npm run seed:test:self-check` | Fixture checks with disposable MongoDB; never weaken database safety guards |
| `npm run test:journey` | Real API/data journey with disposable MongoDB |
| `npm run test:visual` | Browser QA; requires MongoDB binary, Chrome and a current frontend build |

## Keep the handoff useful

- Update `docs/current_task.md` at meaningful milestones and before ending implementation work or handing it off.
- Record the objective, approved decisions, affected files, checks, remaining work and next action; replace stale state while preserving unresolved blockers and linking to their owning work item (`CLAUDE.md` §13).
- Mark finished tasks completed. Do not turn the handoff into an accumulating conversation transcript.
- Update `docs/context.md` only when stable architecture or navigation changes.
- Put lasting decisions and delivery status in the existing design note/roadmap; link rather than duplicate them. Preserve `CLAUDE.md` §12.4 updates to the engineering map, phase rows and applicable QA dashboard alongside the code.
- Keep documentation changes alongside the work they describe. Do not create commits merely to update the handoff.
