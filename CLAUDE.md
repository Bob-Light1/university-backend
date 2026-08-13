# CLAUDE.md — Backend (Node.js / Express / Mongoose)

> Multi-campus academic SaaS ERP. Stack: Node.js · Express · Mongoose · JWT · Multer/Formidable · Cloudinary · node-cron · Puppeteer.
> Entry: `server.js` (boot, crons, graceful shutdown) → `app.js` (Express app, route mounting). API prefix: `/api/`.

## Monorepo paths

| Layer | Path |
|---|---|
| **Backend** | `/home/adminsecu/Projects/university/backend` |
| **Frontend** | `/home/adminsecu/Projects/university/frontend` |

**Full-stack tasks** — when a change touches both layers, keep the contract consistent end-to-end:
- API shape changes (route, method, payload, response fields) must be reflected in the frontend API client in the same task.
- Enum values, status strings, and error codes defined in backend models/constants must match exactly what the frontend expects — never duplicate literals; if they diverge, the backend is the source of truth.
- New or renamed endpoints must be registered in `app.js` **and** updated in the frontend service/hook that calls them before the task is considered done.

---

## 0. Language & comments — MANDATORY

- **All comments, JSDoc, log messages, and identifiers in code and files MUST be written in English**, following professional conventions (clear, concise, no redundant narration of obvious code).
- JSDoc per file (`@file` / `@description`) and per public function/route.
- This applies to every new and edited file — no French in code artifacts.

---

## 0.1 DRY — MANDATORY

- **Do not repeat yourself.** Before writing logic, look for an existing helper — `utils/response-helpers.js`, `shared/utils/` (`soft-delete`, `validation-helpers`, campus filters), `shared/lib/`, the module's own `*.service.js` / `*.repository.js` / `*.helper.js`. Reuse it; do not re-implement, copy-paste or paraphrase it.
- Duplicated logic in 2+ places must be extracted: intra-module → `<domain>.helper.js` or the service; cross-module → `shared/`. Never `require()` another module's internals — go through its `index.js` public surface or a shared helper.
- Single source of truth for values: enums (`Object.freeze({})` in models/constants), status strings, error codes, limits. Never hard-code a literal that already exists as a constant, on either side of the stack (backend is the source, the frontend mirrors it).
- **Factorization must not cost efficiency or clarity.** A helper that forces an extra DB round-trip, breaks a `Promise.all([...])`, drops `.lean()`, or adds an indirection layer nobody can follow is worse than the duplication it removes. Prefer parametrized helpers over deep abstraction; keep two similar-looking blocks separate when they answer different rules that will diverge (accidental duplication ≠ real duplication).

---

## 1. Modular architecture

Code is organized as **self-contained modules** under `modules/<domain>/`. Migration from the legacy monolith is complete.

Typical module layout:
```
modules/<domain>/
  index.js                 # public surface: exports { router, service }
  <domain>.routes.js       # Express router
  controllers/             # split by concern (see §3)
  <domain>.service.js      # business logic, cross-document validation
  <domain>.repository.js   # DB access layer
  models/                  # Mongoose schemas
  *.cron.js / *.worker.js  # background jobs (scheduled from server.js)
```

Modules: `admin · campus · student · teacher · parent · mentor · staff · class · level · subject · department · course · result · document · exam · academic-print · partner · announcement · gaet · settings · notification · finance · public-portal · account · ai`.

---

## 2. Campus Isolation — SECURITY BOUNDARY (non-negotiable)

| Role | Scope |
|---|---|
| `ADMIN` / `DIRECTOR` | All campuses — no filter |
| `CAMPUS_MANAGER` / `TEACHER` / `STUDENT` / `PARENT` / `MENTOR` | Own campus (`req.user.campusId`) |

- Every DB query on scoped collections (`Student`, `Teacher`, `Class`, `Subject`, `Result`, `Schedule`, `Attendance`, `Document`, `Announcement`, `Staff`) **must** include `campusId` for non-global roles.
- `req.body.campusId` is **never** trusted for scoped roles — always `req.user.campusId`.
- Use helper `getCampusFilter(req, res)`; never inline the filter. Check `isGlobalRole(role)` before skipping it.
- Document routes: always `enforceCampusAccess` (`document.campus.middleware.js`).

---

## 3. Controllers

- Split around ~300 lines by concern: `*.crud` / `*.workflow` / `*.analytics` / `*.helper` / `*.profile` / `*.readonly`.
- Wrap every async controller with `asyncHandler`.
- Campus filter via `getCampusFilter()` — never duplicated inline.
- Parallel DB calls with `Promise.all([...])`; read-only queries use `.lean()`.
- `'use strict'` + file-level JSDoc at the top.

---

## 4. Response helpers — REQUIRED (never `res.json()` directly)

From `utils/response-helpers.js`:
```
sendSuccess · sendCreated · sendPaginated · sendError
sendNotFound · sendForbidden · sendUnauthorized
sendConflict · sendValidationError
handleDuplicateKeyError · asyncHandler
```
Response shape: `{ success, message, data, meta }`.

---

## 5. Models

- Campus-scoped: `campusId: { type: ObjectId, ref: 'Campus', required: true, index: true }`.
- Global collections (`Course`, `Partner`, `GradingScale`): no `campusId`.
- Enums: `Object.freeze({})` — exported and reused across backend controllers/validators (the frontend mirrors the same values in its Yup schemas).
- Auto-increment refs via `counter` model. `{ timestamps: true }` on every schema.
- Compound indexes at schema level for frequent query patterns.

### 5.1 Soft delete — THREE conventions, one helper

There is **no single soft-delete field** in this codebase. Three conventions coexist, one per family of models. They are all legitimate, but they are **not interchangeable**, and writing the wrong one fails *silently*.

| Family | Marker | Deleted when | Models (12 / 13 / 2) |
|---|---|---|---|
| **Actors & configuration** | `status` enum containing `'archived'` | `status === 'archived'` | `Student` `Teacher` `Parent` `Mentor` `Staff` `Class` `Subject` `Course` `Department` `Campus` `Level` `Partner` |
| **Records & transactions** | `isDeleted` | `isDeleted === true` | `Result` `ExamSession` `ExamEnrollment` `ExamGrading` `ExamSubmission` `ExamAppeal` `QuestionBank` `Income` `Expense` `ExpenseCategory` `StudentFee` `StudentSchedule` `TeacherSchedule` |
| **GED & announcements** | `deletedAt` only (no boolean) | `deletedAt !== null` | `Document` — soft-deleted docs **keep** `status: PUBLISHED`<br>`Announcement` — soft-deleted ones **keep** `status: published` |

The other ~29 models (logs, junctions, tokens, snapshots, `Notification`, `PrintJob`, `QuizSession`, `FinalTranscript`, …) have **no** deletion marker — deletion is not a concept for them.

**Never hand-write a not-deleted filter.** Three silent failure modes, all of which return a plausible-looking result set:
- `{ isDeleted: false }` on `students` matches **nothing** — the field does not exist.
- `{ status: { $ne: 'archived' } }` on `results` filters **no deletion at all** — `Result.status` is a *workflow* state (`PUBLISHED` / `ARCHIVED`, uppercase); an ARCHIVED result is live.
- `{ status: { $ne: 'archived' } }` on `announcements` is wrong **in both directions** — `'archived'` there is the *expiry* state written by the nightly cron, so the filter hides live announcements and returns deleted ones.

**Two models carry both markers and mean opposite things**, so their convention is *declared*, not inferred — `STRATEGY_OVERRIDES` in `shared/utils/soft-delete.js`:

| Model | Marker | Why the other field exists |
|---|---|---|
| `Announcement` | `deletedAt` | `status: 'archived'` = expired, set by the nightly cron on a **live** record |
| `Course` | `status` | `archiveCourse()` writes both together; `deletedAt` is the timestamp companion |

Any *other* model carrying both an `'archived'` status enum and a `deletedAt` field makes the helper **throw** until it is declared there. Guessing is how the Announcement bug happened.

Derive the filter from the model instead — `shared/utils/soft-delete.js`:

```js
const {
  notDeletedFilter, deletedOnlyFilter,   // reads
  softDeletePatch,  restorePatch,        // writes
} = require('shared/utils/soft-delete');

Student.find({ ...campusFilter, ...notDeletedFilter(Student) });   // → status: { $ne: 'archived' }
Result.find({  ...campusFilter, ...notDeletedFilter(Result)  });   // → isDeleted: false
Document.find({ ...campusFilter, ...notDeletedFilter(Document) }); // → deletedAt: null
```

Writing the marker the wrong way is the symmetric bug to filtering on it, and just as silent: assigning `status` on a schema that has no such path is dropped by Mongoose (`strict: true`), `save()` resolves, and the route reports an archive that archived nothing. So the write side is derived too — `softDeletePatch(Model)` and its exact undo `restorePatch(Model)`, which restores to the schema's own declared default and clears the `deletedAt` / `deletedBy` companions when the schema carries them.

A model with no convention **throws** rather than returning `{}` — an empty filter would silently include deleted documents. Fail closed, like `buildCampusFilter()`. `tests/unit/soft-delete.test.js` pins these conventions against the real schemas: change a model's marker and that suite tells you which queries you just broke.

**Where the helper is wired** (the rest of the codebase still carries hand-written filters that are correct today — do not add more):

| Site | Why it is derived rather than literal |
|---|---|
| `shared/lib/generic-entity.controller.js` — list / archive / restore / stats | Generic controller: its convention must come from whichever model is wired to it, not from its own source. `tests/unit/generic-entity.controller.test.js` pins the four sites against all three families. `getStats` scopes on *live*, not on `status: 'active'` — the narrower match dropped every `pending` / `inactive` / `suspended` row from `totalEntities` (the activation flow creates accounts as `pending`, so an imported cohort was invisible until activated) and made the `byStatus` facets of `department` / `campus` structurally single-valued. |
| `announcement.repository.js`, `course.repository.js` + `course.helper.js` | The two `STRATEGY_OVERRIDES` models — the only ones where a reader of the schema can be wrong in good faith. |
| `finance.repository.js`, `exam.repository.js`, `result.repository.js` | Money and academic records. Inside an aggregation `$match` a marker that does not exist raises nothing: it returns `0`, and a total of `0` reads as a figure rather than as a broken query. |
| `campus.model.js` quota methods | `canAddStudent` / `canAddTeacher` / `canAddClass` / `canAddDocumentStorage` resolve their models lazily and count against a tenant's plan limits. |

`result.repository.aggregateCampusOverview()` appends the fragment **last, inside the repository**, so no caller can forget it or override it — the model's owner owns its deletion filter. Prefer that shape when adding an aggregate.

Mocked models must carry `modelName` + a schema stub — `tests/helpers/soft-delete-stub.js`. A bare bag of `jest.fn()` no longer stands in for a model, and the stub states in each repository's own test which convention that repository assumes.

### 5.2 Hard delete — ONE harmonized system, `shared/lib/hard-delete/`

Soft delete is the default everywhere. **Permanent deletion has exactly one implementation** — no module reaches around it, and an entity that is not declared in the registry simply cannot be hard-deleted. The danger zone is an allowlist, never a fallback.

```
shared/lib/hard-delete/
  hard-delete.constants.js   # RELATION_MODE · DELETION_OUTCOME · phrase builder · TTL
  hard-delete.registry.js    # WHAT is deletable and WHAT each deletion touches
  hard-delete.guard.js       # the four controls (ticket · phrase · password · reason)
  hard-delete.service.js     # preview() + execute() — the only removal code path
  hard-delete.controller.js  # HTTP surface
  hard-delete.routes.js      # mounted at /api/danger-zone
  deletion-audit.model.js    # append-only ledger (DeletionAudit) — never deleted
```

**API** (per-entity roles come from the registry; the router itself allows ADMIN / DIRECTOR / CAMPUS_MANAGER):

| Route | Purpose |
|---|---|
| `GET /api/danger-zone/entities` | Entity types the caller may delete + confirmation policy |
| `GET /api/danger-zone/:entityType/:id/impact` | Read-only impact report; **issues the deletion ticket** |
| `DELETE /api/danger-zone/:entityType/:id` | Executes; body = `{ ticket, confirmationPhrase, password, reason }` |
| `GET /api/danger-zone/history` | Paginated deletion ledger (completed **and** refused) |

#### The four controls — all mandatory, all fail closed

1. **Ticket** — HMAC-signed (JWT_SECRET), TTL 300 s, bound to *(actor, entityType, entityId, impact digest)*. Minted only by the preview, and only when nothing blocks. A deletion therefore **can never be fired blind**, and if the data changed between preview and execute the digest no longer matches → 409, re-preview required.
2. **Confirmation phrase** — the operator retypes `DELETE <identifier>` verbatim (server-computed from the business key: matricule, code, reference…). Defends against the wrong row.
3. **Password** — the actor re-authenticates against their own credential store (`ADMIN`/`DIRECTOR` → `Admin`, `CAMPUS_MANAGER` → `Campus`; any other role → refused, never guessed).
4. **Reason** — ≥ 10 chars, stored forever in `DeletionAudit`.

Plus four structural rules:
- **archive first** — a live record cannot be hard-deleted; permanent deletion is always a *second* decision, verified via `deletedOnlyFilter`;
- **blockers are re-counted inside the transaction**, not only at the gate: a result published between the confirmation and the commit refuses the deletion instead of being orphaned;
- **cascade volume cap** (`MAX_CASCADE_DOCUMENTS` = 5000) — cascades run in one transaction, bounded by the 16 MB oplog entry and the 60 s lifetime, so an oversized deletion is refused up front rather than aborting mid-flight;
- a dedicated rate limiter (10/h per IP, own store prefix — do **not** reuse `strictLimiter`, its 3/h budget is shared with GAET/admin/partner).

Every attempt is audited, not just the successful ones: a wrong password, a mismatched phrase, a forged or expired ticket and an aborted transaction all write a `DeletionAudit` row (`outcome: 'failed'`), alongside `'blocked'` and `'completed'`.

#### Relation modes — declared per entity in the registry

| Mode | Meaning | Applies to |
|---|---|---|
| `BLOCK` | Deletion **refused** while ≥ 1 match exists | Official academic / financial records: `Result`, `FinalTranscript`, `FeePayment`, `Income`, `ExamGrading`, attendance history, live schedules, live `Document`… |
| `CASCADE` | Deleted in the **same transaction** | Derived rows: unpaid attendance, enrollments, notifications, preferences, activation tokens, retired schedule slots |
| `DETACH` | Reference `$pull`/`$unset`, related doc **survives** | `Class.students`, `Parent.children`, `Student.mentor`, `Department.headOfDepartment`… |
| `RETAIN` | Reference **deliberately left** pointing at the removed id | Provenance on a *required* field (`recordedBy`, `publishedBy`, `Result.classManager`) and the append-only ledgers (`DocumentAudit`, `DeletionAudit`) |

`RETAIN` exists so the dangling case is **declared, counted and shown to the operator** instead of being the implicit default. Detaching there would leave a surviving document in breach of its own schema (`updateMany` runs no validators); blocking would make any actor who ever touched a record permanently undeletable.

`Result` / `FinalTranscript` / `FeePayment` are **never** CASCADE nor DETACH from anywhere. `tests/unit/hard-delete.test.js` pins that, pins every relation filter against the real schemas (a filter on a non-existent path silently matches nothing: a cascade that deletes zero rows, or a blocker that never blocks), and — the check that matters most — pins that **every `ref` in every schema pointing at a deletable entity is declared by one of its relations**. It loads the model files from disk rather than trusting `mongoose.modelNames()`, so a model nobody imported cannot hide from it.

Registered entities: `student · teacher · parent · mentor · staff · staff-role · class · subject · department · level · course · partner · announcement · campus · document`.

#### Adding an entity

Declare it in `hard-delete.registry.js` — model, roles, `campusPath`, `identifier`, `display`, `requireArchivedFirst`, relations. Nothing else to write: routes, gate, transaction and audit are generic. The test suite validates the new entry automatically, **and fails until every schema reference to it is declared**.

Adding a campus-scoped model anywhere in the platform also fails that suite until it is declared on the `campus` entry — a campus is the tenant boundary, and an undeclared collection is a whole tenant's rows stranded behind a removed `schoolCampus`.

#### Legacy routes

`DELETE /api/students/:id/permanent`, `/teachers`, `/staff`, `/mentors`, `/staff-roles/:id`, `/api/parents/:id?hard=true` and `/api/documents/:id?hard=true` still exist as **compatibility aliases** — they now delegate to `hardDelete.service.execute()` and require the same body. `document` keeps a `customExecutor` (version purge + **share-link purge** + storage cache + DocumentAudit + ai-service re-ingest) but clears the same gate; a `customExecutor` entry may therefore declare only `BLOCK`/`RETAIN` relations, and names what its own teardown covers in `handledByExecutor` (the registry test refuses a `CASCADE`/`DETACH` that would be counted and never applied). Repository helpers such as `deleteStudentById` / `hardDeleteScoped` are **unguarded and unrouted** — migration scripts only, never a controller.

`?hard=true` is read for **every** role and refused by the registry when the role is not allowed. Gating the flag on the role in the controller would silently downgrade an explicit permanent-deletion request into an archive and report it as a success.

#### Frontend

`src/services/dangerZoneService.js` + `src/components/shared/HardDeleteDialog.jsx` (impact → phrase + password + reason, with ticket countdown) and `HardDeleteAction.jsx`. `GenericEntityPage` exposes the action **only** to ADMIN and **only** on archived rows, via the `dangerZoneEntityType` prop set in each `*Config.jsx`. i18n under `common.hardDelete.*` (10 locales).

**Outside this system**, only three exceptions — none of them business data:
- `ActivationToken` cleanup (`account.service.js`) and TTL-expiring collections;
- the GED teardown reached *through* the gate (`document.service.hardDeleteDocument`);
- **public-portal marketing content** — `portal-admin.factory.js` `remove()` hard-deletes `Testimonial` / `FaqEntry` / `QuizQuestion` / `CoursePreview` / `CompetitionPrize` / `ContactMessage` with a plain campus-scoped `findOneAndDelete`. Deliberate: this is editorial content with no academic, financial or personal record attached, and it is authored and discarded in the same screen. It is CASCADEd when its campus goes.

---

## 6. Validation

> **Yup is a frontend-only dependency — it is NOT installed on the backend.** Do not add Yup or a generic `validate()` middleware to a backend module.

**Backend (two layers):**
1. **Input layer** — validated in the controller (presence, format, enums). `ObjectId` fields via `isValidObjectId()` from `shared/utils/validation-helpers`. The model also enforces enums / `maxlength` / required as the last line of defense.
   - *Optional route-layer middleware:* a module may extract input validation into hand-rolled middleware under `modules/<domain>/validations/*.schema.js` (plain JS, no Yup) returning `400 { success, message, errors: [{ field, message }] }`. Currently only `parent` does this; follow that pattern if you add one.
2. **Service / cross-document layer** — checks that span documents (circular deps, quotas, conflicts, campus membership).

**Frontend** — Yup schemas under `src/yupSchema/`; `ObjectId` fields use `.matches(/^[a-f\d]{24}$/i, 'Invalid ID format')`; enums mirror the backend models exactly (single source of truth = backend).

---

## 7. Routers

- Named routes declared **before** `/:id` (Express conflict prevention).
- Public routes first, then `router.use(authenticate)`.
- JSDoc per route: `@route` `@desc` `@access`.
- `apiLimiter` on GET, `uploadLimiter` on file uploads, `loginLimiter` on auth endpoints.

---

## 8. Security (enforce on every new module)

- `helmet()` + `express-mongo-sanitize` applied globally in `app.js` — do not repeat.
- `campusId` never from `req.body` for scoped roles.
- Passwords: bcrypt rounds = 12. JWT payload minimal `{ id, role, campusId }`, expiry 7d.
- Append-only audit log entry on every post-publication mutation.

---

## 9. Registered routes (mounted in `app.js`)

```
/api/admin          /api/campus         /api/students       /api/teachers
/api/parents        /api/mentors        /api/staff          /api/staff-roles
/api/class          /api/level          /api/subject        /api/department
/api/results        /api/courses        /api/documents      /api/examination
/api/print          /api/partners       /api/announcements  /api/gaet
/api/settings       /api/notifications  /api/finance        /api/account
/api/danger-zone  (harmonized permanent deletion — see §5.2)
/api/ai  (Phase 3 gateway — inert without AI_SERVICE_URL)
/internal/ai  (S2S read API for ai-service — never published by the reverse proxy)
/api/schedules/student  /api/schedules/teacher
/api/attendance/student /api/attendance/teacher
/api  (public-portal: campuses, pre-register, programs, quiz, competition, …)
/api/ping           /api/health         /health
```

---

## 10. Special modules

**GAET** (`/api/gaet`) — Automatic Timetable Generation. `GaetConstraint` with 7-state machine (`DRAFT → GENERATING → GENERATED → PUBLISHED → …`); CPU-bound worker on an isolated thread; conflict service; zombie recovery at boot (`GENERATING` > 15 min → `FAILED`).

**Exam** (`/api/examination`) — sessions, enrollments, grading, submissions, appeals, question-bank, certificates, analytics; analytics worker; nightly anti-cheat cron.

**Document** (`/api/documents`) — GED with versioning; PDF via Puppeteer pool; QR codes, templates, sharing, audit trail; weekly retention cron.

**Academic-print** (`/api/print`) — print jobs persisted in MongoDB (`PrintJob` model); atomic worker claim + cron sweep of pending/stale jobs.

**Notification** (`/api/notifications`) — multi-channel (in-app + email) with templates; recipient-language i18n via `UserPreferences`; retry cron flushing external sends.

**Finance** (`/api/finance`) — fees, expenses, income; nightly overdue-fee detection + reminders.

**Public-portal** (`/api`) — public-facing: pre-registration, programs, quiz/leaderboard, recruitment competitions; monthly competition-closing cron.

**AI** (`/api/ai` + `/internal/ai`) — Phase 3 gateway to the Python `ai-service` (sibling repo). No Mongoose model; per-campus entitlement lives on `Campus.aiEntitlement` (plans/features/budget, `shared/constants/ai.constants.js`). Scope travels in a short-lived S2S JWT (HS256, TTL ≤ 300 s), never in the body. Inert without `AI_SERVICE_URL` (503). Design doc: `docs/architecture/PHASE3_AI_DESIGN.md`.

**Locale** — `middleware/locale/locale.middleware.js` applied globally.

---

## 11. Active crons (scheduled in `server.js`)

| Schedule | Job |
|---|---|
| Sun 02:00 | Document retention |
| Nightly 03:00 | Exam anti-cheat |
| Nightly 01:00 | Announcement expiry |
| Nightly 06:00 | Finance overdue fees + reminders |
| 1st of month 00:05 | Competition closing |
| Every 10 min | Notification retry (external sends) |
| Every 2 min | Print queue sweep |

---

## 12. Compaction instructions

Always preserve: current task and status (done / in progress / blocked); files created or modified this session (one-line each); campus-isolation or middleware-chain decisions; active errors and root cause if known; validation/schema changes decided this session; the next step or open question.

Drop: contents of files already written to disk, resolved stack traces, abandoned approaches.
