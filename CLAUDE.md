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

- Campus-scoped: `campusId: { type: ObjectId, ref: 'Campus', required: true, index: true }`.
- Truly global collection: **`Course` only** — no campus field at all.
- **Campus-scoped under a different field name — `schoolCampus`, not `campusId`**: `Partner`,
  `PartnerLead`, `PartnerCommission`, `PartnerApplication`, `GradingScale`. `partner.model.js`
  declares `schoolCampus` **required** under an explicit isolation invariant and indexes it four
  times; `GradingScale.getDefault(campusId)` filters on it; the `PARTNER` token's `campusId` is
  derived from it. Grepping for `campusId` alone will therefore report these as global and they
  are not — the mistake that reached `docs/architecture/QA_TEST_STRATEGY.md` v1.1 (its D-15).
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

**Finance** (`/api/finance`) — fees, expenses, income; nightly overdue-fee detection + reminders.

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
| 1st of month 00:05 | Competition closing |
| Every 10 min | Notification retry (external sends) |
| Every 2 min | Print queue sweep |

---

## 11bis. `docs/cours/` — a separate git repository, not dead weight

`docs/cours/` is **its own git repository**, nested here on purpose. It is invisible to this
repo (`.gitignore` line 7, `docs/*`), so `git status` never shows it and it is easy to mistake
for an untracked scratch folder. It is not: it holds the ERP training program (~60 700 lines,
204 files) with its own history, its own remote and its own commit cadence.

- **Commit course changes from `docs/cours/`**, never from here. The two histories are unrelated.
- **Do not move or delete that folder.** 35 solution files resolve *this* backend from their
  position on disk — 8 straight through `require()`/`path.join('../../../../…')`, 27 through a
  named `REPO_ROOT`/`BACKEND = path.resolve(__dirname, '../../../..')`. A symlink does not help;
  Node resolves the real path. Lesson `f1.1` reaches **all four bricks**, the portal included
  (from `~/Projects/partner`), so moving any of them breaks it. `docs/cours/README.md`
  §"Where this lives" states the invariant.
- **Changing backend code can silently break lessons.** The Track 08–12, 18–19 and F solutions
  load real modules and count real figures (modules, routes, models, exported surfaces) against
  numbers printed in the lesson prose. `docs/cours/check-solutions.sh` is the check, in two
  phases: `check-references.js` resolves every repository path cited in the lessons, then all
  57 executable solutions run their own assertions (14 snippets are listed and skipped). All
  green today. Worth running after a structural refactor — a red figure check means a lesson now
  states a false number, and the fix belongs in the lesson text, not in the assertion.

---

## 11ter. Fixture de test déterministe — `tests/fixtures/`

Le jeu de données synthétique sur lequel s'appuient les couches de test (CH-0 de
`docs/architecture/QA_TEST_STRATEGY.md`, livré le 2026-08-21).

```bash
npm run seed:test -- --ephemeral   # base jetable en mémoire : aucun MongoDB requis
npm run seed:test -- --print       # table des 18 comptes (9 rôles × 2 campus)
npm run seed:test:self-check       # 16 contrôles : budget, idempotence, verify, login réel
```

- **Deux campus, neuf rôles connectés, 283 documents, identifiants figés.** Les `ObjectId`
  sont dérivés d'une clé métier (`student:A:001`), les dates d'une **ancre** fixe, et le sel
  bcrypt de la graine — deux exécutions produisent une base identique octet pour octet.
- **Le seed refuse toute base qui n'est pas locale et nommée comme une base de test**
  (`seed.config.js`, `assertTestDatabaseUri`). Il purge avant de construire : ne jamais
  affaiblir ce garde-fou pour faire passer une URI.
- **Les volumes attendus vivent dans `seed.config.js` (`COUNTS`)** et nulle part ailleurs :
  `verify.js` les lit, il ne les redéclare pas.
- **Les marqueurs de suppression y passent par le helper** (`ctx.softDelete(model)`), comme
  partout ailleurs (§5.1). La fixture matérialise volontairement les trois pièges : un
  `Result` `ARCHIVED` **vivant**, une `Announcement` `archived` **vivante** (expirée), un
  `Document` supprimé qui **garde** `status: PUBLISHED`.
- `tests/fixtures/.generated/` est gitignoré : il contient le mot de passe de test en clair.

---

## 11quater. Feuille de route produit — `docs/architecture/ERP_ROADMAP.md`

**La source de vérité de l'avancement produit**, sur les quatre briques. Elle remplace
`ERP_2026_v2.pdf` (l'ancien catalogue commercial) comme référence de planification : ce
catalogue contenait six affirmations que le code contredit, toutes traitées au §11 de la
feuille de route — ne jamais s'y référer pour établir un état d'avancement.

⚠️ **Le fichier `ERP_2026_v2.pdf` a été écrasé le 2026-08-22** par la vue rendue de la feuille
de route (décision du porteur). Le catalogue ne subsiste que par les citations relevées à son
§11 : c'est la seule trace de ce qui a été affirmé, et la raison pour laquelle elles y sont
conservées mot pour mot.

- **Cinq phases**, établies d'après l'état *mesuré* du code et non d'après ce qui a été annoncé :
  `1-A` livré · `1-B` commencé et pas fini · `2` socle de fabrication · `3` ERP complet ·
  `4` premium et industrialisation. **212–275 j** restants hors application mobile, et la phase
  1-A chiffrée en **valeur de reconstruction** (204–284 j) depuis l'audit v4 du 2026-08-22.
- **Le §0 est le tableau de bord** et fait foi, comme celui de `QA_TEST_STRATEGY.md`. Un commit
  qui termine ou démarre un chantier met à jour, *dans le même commit*, la ligne du §0 et la
  colonne `État` de la phase concernée. Les deux tableaux de bord doivent rester cohérents :
  un chantier `CH-*` terminé se répercute dans les deux.
- **Ce qui est vendu est un palier, pas une phase** — `free` 15 clés / `standard` 22 / `premium`
  26, dérivés de `PLAN_PRESETS`. Les phases sont un calendrier de production interne, que le
  client n'a pas à connaître. Les deux grilles commerciales (§10) s'adossent aux paliers.
- **Une vue rendue est publiée comme artifact**, régénérée depuis ce fichier aux jalons où elle
  doit être montrée. Le fichier fait foi ; la vue est un instantané daté, jamais l'inverse.

---

## 12. Compaction instructions

Always preserve: current task and status (done / in progress / blocked); files created or modified this session (one-line each); campus-isolation or middleware-chain decisions; active errors and root cause if known; validation/schema changes decided this session; the next step or open question.

Drop: contents of files already written to disk, resolved stack traces, abandoned approaches.
