# Project context

Last documentation review: 2026-09-19.
This map helps with navigation; the code describes the implemented behavior.
It does not certify a deployment or passing tests.

## Product and scope

A school and university management platform for multiple campuses: academic administration,
people, results, exams, finances, documents, communication and recruitment.
Each role has its own permissions and data scope.
Per-campus plans can enable modules, make them read-only or hide them.

## Four separate repositories

Paths are relative to the backend root; verify their availability on another machine.

| Repository | Path | Role and technology |
|---|---|---|
| Backend | `.` | `/api` API, Node.js / Express / Mongoose, default port 5000 |
| ERP frontend | `../frontend` | Authenticated workspaces, React / Vite / MUI |
| AI service | `../ai-service` | Python / FastAPI / PostgreSQL with pgvector; called by the backend |
| Public portal | `../../partner` | Next.js; programs, pre-registration, quizzes and referrals |

Each sibling repository now has an `AGENTS.md` startup protocol, `docs/context.md`
navigation map and `docs/current_task.md` handoff:
[frontend](../../frontend/AGENTS.md), [AI service](../../ai-service/AGENTS.md),
[public portal](../../../partner/AGENTS.md). Read the local protocol when working there.

The public portal is not inside the `university` directory.
API contracts, statuses and error codes are defined by the backend.
A contract change requires checking the affected consumers.

## Backend map

| Location | Responsibility |
|---|---|
| [app.js](../app.js) | Express construction, middleware and route mounting; importable for tests |
| [server.js](../server.js) | Configuration, MongoDB connection, scheduled jobs and HTTP listener |
| [modules/](../modules/) | Business domains; routes, controllers, services, repositories and models |
| [shared/middleware/](../shared/middleware/) | Authentication, authorization, limits and module availability |
| [shared/utils/](../shared/utils/) | Validation, campus filters, soft deletion, files and responses |
| [shared/lib/](../shared/lib/) | Entitlement, permanent deletion and job registration |
| [tests/](../tests/) | Unit, contract, integration and journey tests using synthetic data |
| [scripts/](../scripts/) | Migrations, data seeding and dependency audits |

Typical flow: route → controller → service / repository → MongoDB model.
Modules communicate through their `index.js` facades.
Invariants and commands are in [AGENTS.md](../AGENTS.md).

## Domains to consult by task

- Organization: `campus`, `department`, `level`, `class`, `subject`, `course`.
- People and accounts: `admin`, `student`, `teacher`, `parent`, `mentor`, `staff`, `account`.
- Academic activities: `result`, `exam`, `academic-print`, `gaet`; attendance and schedules in `student` / `teacher`.
- Management and communication: `finance`, `document`, `announcement`, `notification`, `settings`.
- Recruitment and assistance: `partner`, `public-portal`, `ai`.

## Runtime dependencies

- [package.json](../package.json) declares Node `20.x` and CommonJS; this is the repository's state, not a version recommendation.
- MongoDB is the primary database; transactional workflows require a compatible configuration.
- `MONGODB_URI` and `JWT_SECRET` are required at startup; never copy their values into documentation.
- Storage uses Cloudinary in production, among other components; review startup checks before changing it.
- Redis enables BullMQ queues and shared storage for some rate limiters; fallback behavior varies by component.
- PDF rendering uses Puppeteer / Chromium; mocked tests do not prove actual rendering works.
- External notifications and AI require their services and configuration; having code present is not sufficient.
- [register-jobs.js](../shared/lib/register-jobs.js) defines scheduled jobs; do not maintain a second list here.

## References and product status

- [CLAUDE.md](../CLAUDE.md): detailed conventions and delivery workflow; consult relevant sections.
- [ERP_ROADMAP.md](architecture/ERP_ROADMAP.md): product tracking, dashboard in §0 and existing decisions.
- [QA_TEST_STRATEGY.md](architecture/QA_TEST_STRATEGY.md): quality strategy and work-item progress.
- [Product home and deployment branding](architecture/features/product-home-and-branding.md): public product presentation, identity precedence and deployment variables; applicant intake remains in the separate portal.
- [Feature notes](architecture/features/): contracts and acceptance criteria for individual work items.
- [AI design](architecture/PHASE3_AI_DESIGN.md): service contracts and decisions; §18 is its handoff. Its historical "Phase 3" label is not the current roadmap's phase 3.
- [Account activation](architecture/ACCOUNT_ACTIVATION_CHANTIER.md): locked onboarding decisions and verification procedure.
- [Licensed feature delivery](architecture/FEATURE_DELIVERY_DESIGN.md): source-license packaging design, not an implemented delivery system; the roadmap also describes a hosted SaaS offering.
- [Modular migration](architecture/MODULAR_MONOLITH_MIGRATION.md) and [PostgreSQL assessment](architecture/POSTGRES_MIGRATION_ASSESSMENT.md): migration history, repository-layer work and prerequisites; neither authorizes a new database migration.
- [current_task.md](current_task.md): dated handoff state to verify against Git.
- [project_resume.md](project_resume.md): project overview and opinions from the conversation; no implied business decisions.

Read each relevant design note's required sections before changing its subsystem.
These summaries do not replace design decisions, phase ordering or delivery/QA acceptance rules.
The January 2026 [README](../README.md) includes the former directory layout and historical
"production-ready" claims; use `CLAUDE.md`, the current code and the roadmap for present state.

Findings from the 2026-09-18 exploration, to recheck before making changes: the
"Mobile Money" payment method is recorded without operator integration; moving a
lead to `enrolled` can create a commission but does not automatically create a student.
The exploration did not run the application or its tests. Historical results in
documentation must not be presented as checks performed during the current session.
