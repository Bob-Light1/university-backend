# CLAUDE.md — Backend (Node.js / Express / Mongoose)

> Multi-campus academic SaaS ERP. Stack: Node.js · Express · Mongoose · JWT · Multer/Formidable · Cloudinary · node-cron · Puppeteer.
> Entry: `server.js` (boot, crons, graceful shutdown) → `app.js` (Express app, route mounting). API prefix: `/api/`.

## Project paths — FOUR bricks

The platform is **four separate git repositories**, not one monorepo. This backend is one of them;
the other three are peers, and two of them consume this API.

| # | Brick | Path | Stack · port | Role |
|---|---|---|---|---|
| 1 | **Backend ERP** *(this repo)* | `/home/adminsecu/Projects/university/backend` | Node · Express · Mongoose — `:5000` | The API and the source of truth for every enum, status and error code |
| 2 | **Frontend ERP** | `/home/adminsecu/Projects/university/frontend` | React · Vite · MUI — `:5173` (Vite default, not pinned) | The signed-in back-office: admin, director, campus manager, teacher, student, parent, mentor |
| 3 | **AI-service** | `/home/adminsecu/Projects/university/ai-service` | Python · FastAPI · Postgres/pgvector — `:8000` (loopback), db `:5434` | RAG, embeddings, chat. Reached **only** through this backend (`/api/ai`), never published directly — see §10 |
| 4 | **Portail-préinscription** | `/home/adminsecu/Projects/partner` ⚠️ | Next.js 15 · next-intl — `:3000` | Public site: pre-registration, programs, quiz, competitions, partner short links `/r/{code}` |

⚠️ **The portal does not live under `university/`.** Its folder is named `partner` (the referral
programme it also serves), it sits next to unrelated projects in `~/Projects`, and nothing on disk
links it back here. Looking for it beside the other three is the obvious mistake — it is not there.

Remotes: `Bob-Light1/university-backend` · `university-frontend` · `university-ai-service` · `parters-portail`.

**Cross-brick tasks** — a change that crosses a brick boundary is not done until every consumer follows:
- API shape changes (route, method, payload, response fields) must be reflected in **each** client that calls
  the route in the same task — the ERP frontend (`src/services/`) and, for anything under the public-portal
  surface (§10), the Next.js portal too.
- Enum values, status strings, and error codes defined in backend models/constants must match exactly what the
  clients expect — never duplicate literals; if they diverge, **the backend is the source of truth** for all three.
- New or renamed endpoints must be registered in `app.js` **and** updated in the frontend service/hook that calls
  them before the task is considered done.
- The wiring between bricks is environment, not imports: backend `PORT` / `PORTAL_URL` / `PORTAL_API_KEY` /
  `AI_SERVICE_URL`, frontend `VITE_API_BASE_URL` / `VITE_PORTAL_URL`, portal `ERP_API_URL` / `NEXT_PUBLIC_PORTAL_URL`.
  Moving or renaming a route means checking these, not only the code.

---

## 0. Language & comments — MANDATORY

- **All comments, JSDoc, log messages, and identifiers in code and files MUST be written in English**, following professional conventions (clear, concise, no redundant narration of obvious code).
- JSDoc per file (`@file` / `@description`) and per public function/route.
- This applies to every new and edited file — no French in code artifacts.

---

## 0.1 DRY — MANDATORY

- **Do not repeat yourself.** Before writing logic, look for an existing helper — `shared/utils/response-helpers.js`, `shared/utils/` (`soft-delete`, `validation-helpers`, campus filters), `shared/lib/`, the module's own `*.service.js` / `*.repository.js` / `*.helper.js`. Reuse it; do not re-implement, copy-paste or paraphrase it.
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
| `CAMPUS_MANAGER` / `TEACHER` / `STUDENT` / `PARENT` / `MENTOR` / `STAFF` | Own campus (`req.user.campusId`) |
| `PARTNER` | Own campus **and own partner record** — see below |

**`PARTNER` is a signed-in role, not just a data record.** It has its own auth controller
(`modules/partner/controllers/partner.auth.controller.js`, `POST /api/partners/auth/login` and the
password-reset pair), its own ERP interface (`frontend/src/partner/`, routed by `PartnerRoutes.jsx`),
and a token carrying `{ id, role: 'PARTNER', campusId, partnerCode, partnerType }`. Its `campusId`
is derived from `partner.schoolCampus` — see §5.

Its isolation is the only one in the platform that is **not campus-to-campus alone**: two partners
of the *same* campus must never see each other's leads or commissions. A filter that carries only
`campusId` lets that through. Every read on `PartnerLead` / `PartnerCommission` for a `PARTNER`
token must also pin the partner id.

- Every DB query on scoped collections (`Student`, `Teacher`, `Class`, `Subject`, `Result`, `Schedule`, `Attendance`, `Document`, `Announcement`, `Staff`) **must** include `campusId` for non-global roles.
- `req.body.campusId` is **never** trusted for scoped roles — always `req.user.campusId`.
- Use `buildCampusFilter(user, requestedCampusId)` (`shared/utils/validation-helpers.js`); never inline the filter. Modules wrap it in a local `getCampusFilter(req, …)` — that wrapper delegates, it never rebuilds the fragment. Check `isGlobalRole(role)` before skipping it.
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

From `shared/utils/response-helpers.js`:
```
sendSuccess · sendCreated · sendPaginated · sendError
sendNotFound · sendForbidden · sendUnauthorized
sendConflict · sendValidationError
handleDuplicateKeyError · asyncHandler
```
Response shape: `{ success, message, data, meta }`.

---

## 5. Models

- **The scoped field is `schoolCampus`, not `campusId`** — 41 models against 8, and it is what
  `buildCampusFilter()` emits (`shared/utils/validation-helpers.js`: `{ schoolCampus: user.campusId }`).
  A new campus-scoped model declares
  `schoolCampus: { type: ObjectId, ref: 'Campus', required: true, index: true }`.
  **Do not read the token field back into the schema**: the JWT payload carries `campusId` (§8),
  the documents carry `schoolCampus`, and the helper is the piece that maps one onto the other.
  A model that declares `campusId` is invisible to every filter built from that helper — the
  query does not fail, it silently scopes on a path that does not exist.
- **The eight exceptions really do use `campusId`**, and they are a family, not an accident: the
  GED (`Document`, `DocumentVersion`, `DocumentShare`, `DocumentTemplate`, `DocumentAudit`) plus
  `PrintJob`, `ActivationToken` and `UserPreferences`. They are scoped by their own paths —
  document routes through `enforceCampusAccess` (`document.campus.middleware.js`, §2) — never by
  `buildCampusFilter()`. `campus.model.js` shows the split in one file: `canAddStudent()` counts
  on `schoolCampus`, `canAddDocumentStorage()` counts on `campusId`, and both are correct.
- Truly global collections: **six**, and `Course` is only the best known of them. Measured against
  the loaded schemas, these carry **no campus path of any name**: `Course`, `Level`,
  `ExpenseCategory` (the finance lookup table — its CRUD is therefore platform-wide for a
  `CAMPUS_MANAGER`, and its "used by N expense(s)" refusal quotes a count taken across every
  campus), plus `Admin`, `Campus` and `Counter`, which are structurally not scoped — two are the
  tenant boundary and its counter, the third is a global actor. **`StaffRole` is scoped on a third
  path name**, `campus` — a grep for `schoolCampus|campusId` reports it as global and it is not.
  `hard-delete.registry.js:419,433` already declared `campusPath: null` for two entries citing this
  line when it named one; corrected 2026-08-26 while authoring course lesson 15.1 (§12.1: the map is
  fixed before the note leans on it).
- Grepping for one name alone reports the other family as global, and it is not — the mistake
  that reached `docs/architecture/QA_TEST_STRATEGY.md` v1.1 (its D-15), which recorded it for
  `Partner` / `GradingScale` while stating the majority convention backwards.
- The reliable inventory of what is campus-scoped is the **hard-delete registry**: its suite fails
  until a scoped model is declared on the `campus` entry (§5.2), which no grep guarantees.
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
  hard-delete.limiter.js     # deletionLimiter (/permanent) · hardDeleteFlagLimiter (?hard=true)
  deletion-audit.model.js    # append-only ledger (DeletionAudit) — never deleted
  index.js                   # public surface: routes · service · constants · respondToError
                             #   + both limiters, so aliases carry the SAME budget.
                             #   Registry, guard and audit model stay internal.
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
- **blockers and cascade volume are re-counted inside the transaction**, not only at the gate: a result published between the confirmation and the commit refuses the deletion instead of being orphaned, and a cascade that grew past the cap is refused with the gate's own message instead of aborting mid-flight;
- **cascade volume cap** (`MAX_CASCADE_DOCUMENTS` = 5000) — cascades run in one transaction, bounded by the 16 MB oplog entry and the 60 s lifetime, so an oversized deletion is refused up front rather than aborting mid-flight. The cap is safe only because `IMPACT_COUNT_LIMIT` (10 000) sits **above** it: impact counts are capped, so the volume is a lower bound, and a cap below the limit would let an oversized cascade read as under-threshold;
- a dedicated rate limiter (10/h per IP, own store prefix — do **not** reuse `strictLimiter`, its 3/h budget is shared with GAET/admin/partner). It lives in `hard-delete.limiter.js`, **not** in the router, and is mounted on the danger-zone route **and on every compatibility alias**: they all reach the same `execute()` and the same password control, so a limiter on the router alone is one that changing URL bypasses. `deletionLimiter` for the dedicated `/permanent` routes, `hardDeleteFlagLimiter` for the `?hard=true` routes (it meters only the permanent form — metering archives on the deletion budget would let ordinary archiving exhaust it).

Every attempt is audited, not just the successful ones: a wrong password, a mismatched phrase, a forged or expired ticket and an aborted transaction all write a `DeletionAudit` row (`outcome: 'failed'`), alongside `'blocked'` and `'completed'`.

The audit write is never allowed to be what fails. Every DeletionAudit payload is built by one `buildAuditPayload()` in the service — so a field cannot be present on the success row and missing on the refusal row — and its free-text fields are **truncated** to `AUDIT_FIELD_LIMITS` (the same constants the schema declares) instead of being handed to Mongoose to reject. A rejected write does not degrade gracefully: on the success path the row is created *inside* the transaction, so it aborts the deletion and makes the entity permanently undeletable; on the refusal path the row is simply lost. `Blocked by: …` over the `campus` entry's thirty-odd BLOCK relations overruns `failureReason` on its own — that is a live case, not a defensive one.

The confirmation phrase is built from `resolveIdentifier()`, which falls back to the id on a blank identifier as well as a null one. `doc.matricule || doc.username` returns `''` when neither is set, and `??` lets it through: the phrase would collapse to a bare `DELETE` (typeable by accident) and `entityIdentifier` (required) would fail the audit write.

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

`DELETE /api/students/:id/permanent`, `/teachers`, `/staff`, `/mentors`, `/staff-roles/:id`, `/api/parents/:id?hard=true` and `/api/documents/:id?hard=true` still exist as **compatibility aliases** — they delegate to `hardDelete.service.execute()`, require the same body **and carry the same rate limiter** (see above; `tests/unit/hard-delete.test.js` fails until a new alias does). `document` keeps a `customExecutor` (version purge + **share-link purge** + **stored-file purge** + storage cache + DocumentAudit + ai-service re-ingest) but clears the same gate; a `customExecutor` entry may therefore declare only `BLOCK`/`RETAIN` relations, and names what its own teardown covers in `handledByExecutor` (the registry test refuses a `CASCADE`/`DETACH` that would be counted and never applied). Repository helpers such as `deleteStudentById` / `hardDeleteScoped` are **unguarded and unrouted** — migration scripts only, never a controller.

`?hard=true` is read for **every** role and refused by the registry when the role is not allowed. Gating the flag on the role in the controller would silently downgrade an explicit permanent-deletion request into an archive and report it as a success.

**Files follow the row.** The generic executor removes `entry.files(doc)` after the commit (`removeFiles`, never throwing — a leftover file is a cleanup task, an uncommitted deletion is not). The GED does the same inside `document.service.hardDeleteDocument` for the imported file, the PDF snapshot, the QR code and **every version's** snapshot, and returns the paths so they land on the ledger row. Version snapshots must be read **before** their rows are deleted — afterwards nothing maps the files on disk back to the document. `branding.logo` is deliberately excluded: it is campus-level artwork shared across documents. A generated PDF that survives its own permanent deletion is a readable copy of a record the operator was told had been destroyed, charged against the campus quota on top.

#### Frontend

`src/services/dangerZoneService.js` + `src/components/shared/HardDeleteDialog.jsx` (impact → phrase + password + reason, with ticket countdown) and `HardDeleteAction.jsx`. i18n under `common.hardDelete.*` (10 locales).

**Every screen goes through `src/hooks/useHardDelete.js` — never through a hard-coded role.** The hook reads `GET /danger-zone/entities` once per signed-in identity (module cache keyed on user + role, so a different account cannot inherit the previous one's permissions; a failed fetch resolves to an empty catalogue and is not retried per mount) and returns:

- `enabled` — the registry lists this entity type for this operator, so render the dialog;
- `canDelete(isArchived)` — the full per-row gate, `requireArchivedFirst` included (it defaults to `true` while the catalogue loads, so a permanent-deletion button never flashes on a live record);
- `requestDelete(id, label)` + `dialogProps` — spread straight onto `<HardDeleteDialog />`.

Restating either rule in a component is a second source of truth for something the registry owns, and it fails in the direction nobody notices: the button is simply missing for an operator entitled to it. That is exactly what the old `hasRole(['ADMIN'])` in `GenericEntityPage` did to `announcement`/`document` (DIRECTOR) and `staff-role` (CAMPUS_MANAGER).

Wired screens — all fifteen registered entities: `GenericEntityPage` via the `dangerZoneEntityType` prop set in each `*Config.jsx` (`student · teacher · parent · mentor · staff`), `Classes.jsx`, `Subjects.jsx`, `ManageDepartment.jsx`, `ManageLevel.jsx`, `CourseManager.jsx`, `PartnerManager.jsx`/`PartnerList.jsx`, `CampusList.jsx`, `StaffRolesManager.jsx`, `AnnouncementAdmin.jsx`, `DocumentManager.jsx`.

**A trash view is a prerequisite, not a nicety.** `requireArchivedFirst` means the operator must be able to *see* soft-deleted rows to select one. The `status: 'archived'` families already listed theirs; the two `deletedAt` models did not, so permanent deletion was unreachable for them — and in the GED the only entry point (a "Delete permanently…" shortcut inside the soft-delete dialog, on a live document) could only ever produce a refusal. Both now list their trash, restricted to the roles that can act on it:

| Endpoint | Trash | Access |
|---|---|---|
| `GET /api/announcements?deleted=true` | soft-deleted announcements, same campus scope | ADMIN / DIRECTOR — 403 otherwise |
| `GET /api/documents?deleted=true` | soft-deleted documents, same campus scope | ADMIN / DIRECTOR — 403 otherwise |

Both refuse the flag rather than silently returning the live list, which would read as "the trash is empty". Both derive the fragment with `deletedOnlyFilter(Model)` — the exact complement of the not-deleted filter every other read carries, so the two cannot drift. In the UI the trash is a toggle (announcements) or a `Deleted` tab (GED) rendered only when `hardDelete.enabled`; rows there expose permanent deletion and nothing else — every lifecycle action is meaningless on a deleted row, and the GED drawer would 404 since each detail endpoint filters on `deletedAt: null`. Neither model has a restore endpoint: soft deletion is retention, permanent deletion is the danger zone.

`DELETE /staff-roles/:id` is a danger-zone alias, so `StaffRolesManager` reaches it through the dialog like everything else. It used to send a bare `api.delete()` behind a `window.confirm`, which the guard refused every time (no ticket, no phrase, no password, no reason) — the button was dead. `deleteStaffRole()` has been removed from `staffService.js` so the shape cannot come back.

The dialog can always go back to step 1 (`rerunPreview`): a ticket lives 5 minutes and reading a long impact report outlasts it easily, and a `409` on execute means the ticket is spent — the report is dropped so the operator re-reads an impact that may have changed, instead of resubmitting a token the server has already refused. `minReasonLength` / `maxReasonLength` travel on `report.requirements` rather than being mirrored as frontend literals; the local constant is a fallback only.

**Outside this system**, only three exceptions — none of them business data:
- `ActivationToken` cleanup (`account.service.js`) and the **four** TTL indexes that are genuinely
  ephemeral: `ActivationToken.expiresAt`, `DocumentShare.expiresAt`, `PrintJob.createdAt`
  (30 d, `PRINT_JOB_TTL_DAYS` — job metadata, and §5.1 already records that deletion is not a
  concept for it) and `QuizSession.expiresAt`, which is set only on an abandoned `pending` session
  and `null` on a completed one — the model declares that invariant in its own header;
- the GED teardown reached *through* the gate (`document.service.hardDeleteDocument`);
- **public-portal marketing content** — `portal-admin.factory.js` `remove()` hard-deletes `Testimonial` / `FaqEntry` / `QuizQuestion` / `CoursePreview` / `CompetitionPrize` / `ContactMessage` with a plain campus-scoped `findOneAndDelete`. Deliberate: this is editorial content with no academic, financial or personal record attached, and it is authored and discarded in the same screen. It is CASCADEd when its campus goes.

⚠️ **A fifth TTL index is not an exception, it is a hole.** `Document` declares `expiresAt`
(`document.model.js:223`, documented "for temporary generated documents") **and a TTL index on it**
(`:305`) — business data, carrying an append-only ledger, registered as a deletable entity with a
`customExecutor` and four controls in front of it. Nothing in the module ever writes that path, so
it is reachable by exactly one route: `PATCH /api/documents/:id` `$set`s the request body verbatim
(`document.service.js:446-454`; the `createDocument.schema.js` its JSDoc credits does not exist, and
there is no `modules/document/validations/`). One field assignment therefore has MongoDB hard-delete
a document within the minute — no `deletedAt`, no `DocumentAudit` row, no `DeletionAudit` row, no
file cleanup, no ai-service prune, and none of the four controls above. The same unfiltered `$set`
also reaches `campusId`, a declared non-`immutable` path: a scoped role moves a row to another
tenant past all three isolation layers, each of which passed on the *read*.

Taught with a runnable check in the course (lesson 14.4, finding ㊷) and **not fixed**. The fix is a
field whitelist on that one `$set` — a cross-brick change, since the GED form decides what the
whitelist must contain, so it is a §12 work item and not a one-line patch.

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
- **A route that renders a PDF takes `pdfLimiter`, not `apiLimiter`** (`shared/middleware/rate-limiter.js`:
  5/min, keyed on the **user** and not on the IP). Rendering is not a read: each request takes a page in
  the platform's single Puppeteer pool, whose cap bounds *concurrency* and not arrival rate, so a burst on
  one route delays every other one — the print-queue sweep included. Keyed per user because a campus office
  reaches the API from one NAT address, where an IP budget lets the first cashier silence all the others.
  Two routes carry it today: the GED export (`/api/documents/:id/export/pdf`, `/bulk/export`, `/bulk/print`)
  and the fee receipt (`/api/finance/payments/:id/receipt`).

---

## 8. Security (enforce on every new module)

- `helmet()` + `express-mongo-sanitize` applied globally in `app.js` — do not repeat.
- `campusId` never from `req.body` for scoped roles.
- Passwords: bcrypt rounds = 12. JWT payload minimal `{ id, role, campusId }`, expiry 7d.
- Append-only audit log entry on every post-publication mutation.

### 8.1 Dependency audit — a gate with a named exception, not a switch

`npm audit --audit-level=high` is all-or-nothing: one advisory nobody can act on turns the CI step
into `continue-on-error`, and from then on it gates nothing. The backend workflow runs
`npm run audit:ci` → **`scripts/audit-gate.js`** instead. It keys findings by their root GHSA id
(one advisory propagating through three packages is one decision) and fails on **any** unaccepted
high or critical — *and* on an accepted entry that has stopped being reported, so an exception
cannot outlive its reason unnoticed. Adding an exception means writing `reason` and `removeWhen`
next to it; accept only what the deployment provably cannot reach.

One entry stands today: **GHSA-jmr9-qjv8-65gv** (`extract-zip`), reachable only from the browser
*download* path this backend never runs. It is unfixable in place: upstream removed the dependency in
`@puppeteer/browsers` 3.x, which is ESM-only and needs Node ≥ 22.12, as is every `puppeteer-core`
built on it — and `require('puppeteer-core')` against v25 throws under CommonJS and under Jest.
`puppeteer-core` therefore stays on the 24.x line. Clearing it is a runtime migration; see also
`engines.node` (`20.x`, and Node 20 is past end of life).

**`package.json` carries two `overrides`, both load-bearing** — neither is cosmetic:
- `uuid: ^11.1.1` — `exceljs` 4.4.0 (latest) pins the vulnerable `uuid@^8`. It calls only `v4`,
  which uuid 11 still exports from its CommonJS build.
- `multer-storage-cloudinary → cloudinary: $cloudinary` — that package is unmaintained and its
  `peerDependencies` still pin `cloudinary@^1.21.0`, the vulnerable line. It touches exactly two
  methods (`uploader.upload_stream`, `uploader.destroy`), both unchanged in v2. **Without this
  override a clean `npm install` stops on `ERESOLVE`.**

Unit tests mock `cloudinary`, `nodemailer`, `sharp` and `puppeteer-core`, so they stay green through
a broken upgrade of any of them. `optimizeImage()` is the sharpest case: it ends in
`catch { return buffer; }`, so a broken image pipeline returns the input and reports success. Verify
those four against real inputs, not against the suite.

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

**Finance** (`/api/finance`) — fees, expenses, income; nightly overdue-fee detection + reminders,
plus a **pre-due cadence** (J-7 / J-3 / due day) that fires from its own marker,
`StudentFee.remindersSent[]`, never from the `lastRemindedAt` / `reminderCount` pair the overdue
dunning claims on — writing one from the other makes the debt skip its overdue reminder on the day
it falls past due, silently (`modules/finance/fee-reminder-kind.js` carries the reasoning).
`GET /payments/:id/receipt` renders the payment receipt as a PDF, in the **student's** language and
through the platform's single Puppeteer pool: `academic-print` exports `renderPdf` /
`getCampusBranding` for it, because a second pool would double the Chrome footprint and escape the
graceful shutdown. The PDF is never stored — see `docs/architecture/features/fee-receipts-and-reminders.md` §4.

**Public-portal** (`/api`) — public-facing: pre-registration, programs, quiz/leaderboard, recruitment competitions; monthly competition-closing cron. Its client is brick 4, the Next.js portal at `/home/adminsecu/Projects/partner` — changing anything here means changing it there too.

**AI** (`/api/ai` + `/internal/ai`) — Phase 3 gateway to the Python `ai-service` (brick 3 — `/home/adminsecu/Projects/university/ai-service`). No Mongoose model; per-campus entitlement lives on `Campus.aiEntitlement` (plans/features/budget, `shared/constants/ai.constants.js`). Scope travels in a short-lived S2S JWT (HS256, TTL ≤ 300 s), never in the body. Inert without `AI_SERVICE_URL` (503). Design doc: `docs/architecture/PHASE3_AI_DESIGN.md`.

**Locale** — `shared/middleware/locale.middleware.js` applied globally.

---

## 11. Active crons (scheduled in `server.js`)

| Schedule | Job |
|---|---|
| Sun 02:00 | Document retention |
| Nightly 03:00 | Exam anti-cheat |
| Nightly 01:00 | Announcement expiry |
| Nightly 06:00 | Finance overdue fees + reminders |
| Nightly 07:00 | Finance pre-due reminders (J-7 / J-3 / due day) — after 06:00, so the day's past-due transition is already applied |
| 1st of month 00:05 | Competition closing |
| Every 10 min | Notification retry (external sends) |
| Every 2 min | Print queue sweep |

---

## 11bis. `docs/cours/` — a separate git repository, not dead weight

`docs/cours/` is **its own git repository**, nested here on purpose. It is invisible to this
repo (`.gitignore` line 7, `docs/*`), so `git status` never shows it and it is easy to mistake
for an untracked scratch folder. It is not: it holds the ERP training program (~76 600 lines,
224 files) with its own history, its own remote and its own commit cadence.

- **Commit course changes from `docs/cours/`**, never from here. The two histories are unrelated.
- **Do not move or delete that folder.** 45 solution files resolve *this* backend from their
  position on disk — 8 straight through `require()`/`path.join('../../../../…')`, 37 through a
  named `REPO_ROOT`/`BACKEND = path.resolve(__dirname, '../../../..')`. A symlink does not help;
  Node resolves the real path. Lesson `f1.1` reaches **all four bricks**, the portal included
  (from `~/Projects/partner`), so moving any of them breaks it. `docs/cours/README.md`
  §"Where this lives" states the invariant.
- **Changing backend code can silently break lessons.** The Track 08–15, 18–19 and F solutions
  load real modules and count real figures (modules, routes, models, exported surfaces) against
  numbers printed in the lesson prose. `docs/cours/check-solutions.sh` is the check, in two
  phases: `check-references.js` resolves every repository path cited in the lessons, then all
  67 executable solutions run their own assertions (14 snippets are listed and skipped). All
  green today. Worth running after a structural refactor — a red figure check means a lesson now
  states a false number, and the fix belongs in the lesson text, not in the assertion.

---

## 11ter. Deterministic test fixture — `tests/fixtures/`

The synthetic dataset every test layer builds on (CH-0 of
`docs/architecture/QA_TEST_STRATEGY.md`, delivered 2026-08-21).

```bash
npm run seed:test -- --ephemeral   # throwaway in-memory database: no MongoDB required
npm run seed:test -- --print       # table of the 18 accounts (9 roles × 2 campuses)
npm run seed:test:self-check       # 16 checks: budget, idempotence, verify, real login
```

- **Two campuses, nine signed-in roles, 283 documents, frozen credentials.** `ObjectId`s are
  derived from a business key (`student:A:001`), dates from a fixed **anchor**, and the bcrypt
  salt from the seed — two runs produce a byte-identical database.
- **The seed refuses any database that is not local and named like a test database**
  (`seed.config.js`, `assertTestDatabaseUri`). It purges before building: never weaken that
  guard to make a URI pass.
- **Expected volumes live in `seed.config.js` (`COUNTS`)** and nowhere else: `verify.js` reads
  them, it does not restate them.
- **Deletion markers go through the helper there too** (`ctx.softDelete(model)`), as everywhere
  else (§5.1). The fixture deliberately materializes all three traps: a **live** `ARCHIVED`
  `Result`, a **live** (expired) `archived` `Announcement`, and a deleted `Document` that
  **keeps** `status: PUBLISHED`.
- `tests/fixtures/.generated/` is gitignored: it holds the test password in clear text.

---

## 11quater. Product roadmap — `docs/architecture/ERP_ROADMAP.md`

**The source of truth for product progress**, across the four bricks. It replaces
`ERP_2026_v2.pdf` (the former commercial catalogue) as the planning reference: that catalogue
held six claims the code contradicts, all handled in §11 of the roadmap — never cite it to
establish a state of progress.

⚠️ **`ERP_2026_v2.pdf` was overwritten on 2026-08-22** by the rendered view of the roadmap
(owner's decision). The catalogue survives only through the quotations collected in its §11:
that is the only remaining trace of what was claimed, and the reason they are kept there
verbatim.

- **Five phases**, established from the *measured* state of the code rather than from what was
  announced: `1-A` delivered · `1-B` started and unfinished · `2` production groundwork ·
  `3` the complete ERP · `4` premium and industrialization. **212–275 days** remaining
  excluding the native mobile app, with phase 1-A costed as **reconstruction value**
  (204–284 d) since the v4 audit of 2026-08-22.
- **§0 is the dashboard** and is authoritative, like the one in `QA_TEST_STRATEGY.md`. A commit
  that finishes or starts a work item updates, *in the same commit*, the §0 row and the `État`
  column of the phase concerned. Both dashboards must stay consistent: a finished `CH-*` item
  shows up in both.
- **What is sold is a tier, not a phase** — `free` 15 keys / `standard` 22 / `premium` 26,
  derived from `PLAN_PRESETS`. Phases are an internal production schedule the customer never
  needs to know. Both commercial grids (§10) hang off the tiers.
- **A rendered view is published as an artifact**, regenerated from this file at the milestones
  where it must be shown. The file is authoritative; the view is a dated snapshot, never the
  reverse.

---

## 12. Feature lifecycle — the single pattern

**Every new feature follows these ten steps, in this order.** The point is not ceremony: it is
that a feature delivered in August and one delivered in March produce the *same* set of
artifacts, in the same places, under the same names.

Two rules govern the sequence and explain why it cannot be rearranged:

> **R1 — Tests come before audits.** An audit finds between 5 and 14 issues here (measured
> across the 13 audits in the history). Fixing them with no safety net and writing the tests
> *afterwards* produces tests that describe the code as it ended up and prove nothing about the
> bug. **An audit finding is closed by a test that was red before the fix** — otherwise the
> audit was just a re-read.
>
> **R2 — Entitlement is a design decision, not a final wiring step.** It sets the module
> boundary: a feature spread across three modules can be switched off in none of them. It is
> decided at step 1, declared at step 3, and only *verified* at step 10.

### 12.1 Phase A — Design

**Step 1 — The design note.** A feature starts with a document, never with a file. It lives in
**`docs/architecture/features/<slug>.md`** — and nowhere else: `.gitignore:7` ignores `docs/*`
with `docs/architecture/` as the only exception, so a `docs/features/` would be tracked by
nobody. One page is enough; fixed template:

| Section | What it freezes |
|---|---|
| Problem & scope | what is in, and **what is explicitly out** |
| Bricks touched | backend · frontend · ai-service · portal (table at the top of this file) |
| Contract | `Object.freeze({})` enums, error codes, response shape (§4), field names |
| Campus scope | `schoolCampus` by default, or the eight-model `campusId` family (§5); and for `PARTNER`, the double key (§2) |
| Deletion | the model's convention: `status` / `isDeleted` / `deletedAt` (§5.1) |
| Entitlement | key inherited from the module, **or** a new key if the unit sells on its own (R2, §12.3) |
| Registries | which of the eleven in §12.5 are touched |
| Definition of done | §12.6, copied in and amended if needed |

A full `docs/architecture/<NAME>.md` — in the format of the eight existing ones — only for a
**work item of its own**: several phases, a new invariant, or ≥ 2 bricks restructured. Prose in
French, every code artifact in English (§0).

**Filling the template means reading this map, and the map can be wrong. When the code
contradicts it, the map is corrected first — in its own commit, before the note is finished.**
Every later audit is run *against the note* (step 6), so a note built on a false premise
launders that premise into the feature and into whatever is audited after it. The first run of
this pattern found §5 inverted — 41 models on `schoolCampus` against 8 on `campusId`, stated the
other way round — because the template asks which campus field the new model carries. That is
the step working, not a detour from it.

**Step 1 may conclude that the feature should not be built, or not as scoped.** A design step
that cannot say no is a formality. Rescoping here costs a page; rescoping at step 6 costs the
build.

The roadmap row comes from here too: create it in `ERP_ROADMAP.md` §0 if the feature is new to
the plan — but most work already has one, and then step 1 changes nothing. The row flips to
`EN COURS` at step 2, when code starts, not here: a design note can still be abandoned.

### 12.2 Phase B — Build

**Step 2 — Model and data.** The `ERP_ROADMAP.md` §0 row flips to `EN COURS` here. Mongoose
schema (`timestamps`, compound indexes on the real query
patterns), a deletion marker matching step 1, `STRATEGY_OVERRIDES` if the model carries both
markers (§5.1), an **expand-only** migration under `scripts/`, and a declaration in
`hard-delete.registry.js` — the entity itself *and* the `campus` entry if the model is scoped
(§5.2).

> Four suites go red **at this step**, before any feature-specific test exists:
> `hard-delete.test.js`, `soft-delete.test.js`, `facades.test.js`,
> `entitlement.frontend-keys.test.js`. These are not tests "to write later": they are the
> registries demanding their declaration. Satisfy them here, not at step 5.

**Step 3 — The backend, bottom-up, registries included.** `repository` (`.lean()`, filters
**derived** through `notDeletedFilter` / `getCampusFilter`, never hand-written) → `service`
(cross-document rules, quotas, transactions) → `controllers` (`asyncHandler`, response helpers,
~300 lines per concern) → `routes` (named routes before `/:id`, limiters, JSDoc `@route`
`@desc` `@access`) → `index.js` (public surface) → mounting in `app.js`. No `require` pierces a
neighbouring module's facade. The eleven registries of §12.5 are declared **here**, along the
way, not in a catch-up pass.

**Step 4 — The consumers, in the same task.** Frontend: `src/services/<x>Service.js`, hook,
screen, Yup schema mirroring the enums (§6), **i18n across all 10 locales**
(`public/locales/<ar|de|en|es|fr|it|ja|pt|ru|zh-CN>/`), a `feature:` key on the navigation
entry, `useHardDelete` if the entity is deletable (§5.2). The Next.js portal if the surface is
public (§10). `ai-service` if the content is ingested. Check the **environment wiring**, not
only the code: `PORTAL_URL`, `AI_SERVICE_URL`, `VITE_API_BASE_URL`, `ERP_API_URL`. *You do not
test at step 9 a brick you did not wire here.*

### 12.3 Phase C — Prove

**Step 5 — Tests for the feature.** Unit repository (models mocked through
`tests/helpers/soft-delete-stub.js`) → unit service → facade contract → integration as soon as
the route carries a guard (campus isolation, entitlement, danger zone). Test data goes in the
deterministic fixture, volumes in `seed.config.js` (`COUNTS`) and nowhere else (§11ter).
**A campus-isolation guard with no isolation test is a guard that was not delivered.**

**Step 6 — Audit of the feature's code.** An adversarial re-read **against the step 1 note**,
not against the memory of what was intended: is the contract honoured, are the filters derived,
is no literal duplicated, are the errors consistent, are the `Promise.all` preserved. Every
finding is recorded, then closed per R1.

**Step 7 — Audit of the platform *with* the feature.** Distinct from the previous one, and the
most profitable: what the new code changes **elsewhere**. Counters and aggregates that now
include new rows; campus quotas; the entitlement `dependsOn` graph; neighbouring crons; danger
zone cascade volume; `ref:` references resolved at runtime by Mongoose, which grep does not see.

**Step 8 — Audit of the tests.** The test that never goes red is the default failure mode here:
in an aggregation `$match`, a non-existent field raises nothing and returns `0` — a zero total
reads as a figure, not as a broken query; a model mocked as a bare bag of `jest.fn()` validates
any deletion convention at all. For every new test: **make it fail on purpose once**. If it
stays green, it guarantees nothing.

**Step 9 — Run it across every brick.** `npm test` · `npm run lint` · `npm run audit:ci` ·
`npm run seed:test:self-check` if the fixture moved · `npm run test:journey` if a journey is
touched · `docs/cours/check-solutions.sh` if the structure moved. Then the consuming bricks:
frontend build, portal, ai-service.

**Step 10 — Browser QA.** `npm run test:visual`, **then eyes on the screen**: both themes, at
least two roles including one campus-scoped role, and the entitlement toggle in all **three**
states — `enabled`, `read_only` (history stays readable, every mutation is refused), `hidden`.
This is the historically skipped step: four work items were declared finished with "visual QA
still pending". **Not done = feature not delivered.**

> **Reminder on entitlement** — the gate is **fail-open** and **is not a security boundary**: an
> unknown or missing key means allowed. Campus isolation (§2) is the boundary; entitlement is
> commercial packaging. And the granularity is the **module** — 26 keys today, for tiers of
> `free` 15 / `standard` 22 / `premium` 26. One key per feature would blow up the grid: a
> feature inside an existing module inherits that module's key.

### 12.4 Closing out

In the **same commit** as the code:

- `CLAUDE.md`: §1 (modules), §9 (routes), §10 (special modules), §11 (crons);
- `ERP_ROADMAP.md` §0 **and** the phase row; `QA_TEST_STRATEGY.md` §0 if a `CH-*` item moves —
  both dashboards must stay consistent (§11quater);
- the step 1 note, updated with whatever the build proved wrong — a note that lies is worse than
  no note, since the next audit will lean on it;
- a conventional commit `type(scope): …`, message in English, stating **what changes** rather
  than what was done.

**The course is conditional.** The obligation is a green `check-solutions.sh` (step 9). A lesson
is written only if the feature introduces a **new pattern** — not one more instance of a pattern
already taught — and its commit is made **from `docs/cours/`**, never from here (§11bis).

### 12.5 The eleven declarative registries

What is expensive here is not writing the logic: it is forgetting one of these declarations.
Almost none of them produces a clean error — but a wrong count, a missing button, a guard that
guards nothing, or a red suite in a module nobody touched.

Walk all eleven, and **write down the ones that receive nothing**. A recorded "nothing" is a
finding; an unrecorded one cannot be told apart from a registry nobody opened. On the first run,
six of the eleven were "nothing" — and that is what made the other five trustworthy.

| # | Registry | Touch it when | What breaks if forgotten |
|---|---|---|---|
| 1 | `app.js` | a route is added or renamed | 404; the route exists for no client |
| 2 | `modules/<x>/index.js` | a new export | a neighbour pierces the facade → `facades.test.js` red |
| 3 | `shared/constants/features.constants.js` | a module or sellable surface | it escapes the tiers, so it escapes the product; the frontend mirror is pinned by `entitlement.frontend-keys.test.js` |
| 4 | `hard-delete.registry.js` | a new model, deletable **or** merely campus-scoped | `hard-delete.test.js` red; otherwise orphan rows behind a removed campus |
| 5 | `soft-delete.js` (`STRATEGY_OVERRIDES`) | a model carrying `status:'archived'` **and** `deletedAt` | the helper **throws** — that is the protection, not the failure |
| 6 | `register-jobs.js` + §11 | a new cron | the job does not run and the server starts up healthy |
| 7 | `tests/fixtures/seed.config.js` (`COUNTS`) | the fixture gains documents | `verify.js` and `self-check` are wrong, and say nothing useful |
| 8 | `shared/i18n/catalogs/` + `public/locales/×10` | any text meant for a human | a raw key on screen, or an English notification to a French-speaking parent |
| 9 | `frontend/src/services/` + the navigation `feature:` key | any route consumed | a dead screen, or one visible on a tier that did not pay for it |
| 10 | `docs/cours/COURSE_HOOKS.md` (**generated**) | a file is moved or renamed | `check-solutions.sh` red: a lesson cites a dead path |
| 11 | `CLAUDE.md` §1/§9/§10/§11 | every single time | the next session works from an out-of-date map |

### 12.6 Definition of done

A feature is finished when **all** of these are true — not before:

- [ ] design note written, and updated with whatever the build proved wrong;
- [ ] contract frozen on the backend, no literal duplicated in any client;
- [ ] campus scope applied through `getCampusFilter()`, `req.body.campusId` never read for a scoped role;
- [ ] deletion filters **derived** from the model, never hand-written;
- [ ] the eleven registries of §12.5 walked one by one;
- [ ] every consuming brick wired, environment wiring included, i18n across 10 locales;
- [ ] unit tests + campus isolation + integration where a guard exists; each one seen red at least once;
- [ ] the three audits done, **each finding closed by a test that was red before the fix**;
- [ ] `npm test`, `lint`, `audit:ci` green; `check-solutions.sh` green if the structure moved;
- [ ] browser QA done: two themes, two roles, the three entitlement states;
- [ ] `CLAUDE.md`, `ERP_ROADMAP.md` §0 (and `QA_TEST_STRATEGY.md` §0 where relevant) updated in the same commit.

**What is not finished gets said.** A scope reduced along the way is the owner's decision, not
the implementer's: deliver the rest and state what is missing, never shrink in silence.

---

## 13. Compaction instructions

Always preserve: current task and status (done / in progress / blocked); files created or modified this session (one-line each); campus-isolation or middleware-chain decisions; active errors and root cause if known; validation/schema changes decided this session; the next step or open question.

Drop: contents of files already written to disk, resolved stack traces, abandoned approaches.
