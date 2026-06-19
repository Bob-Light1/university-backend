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

Modules: `admin · campus · student · teacher · parent · mentor · staff · class · level · subject · department · course · result · document · exam · academic-print · partner · announcement · gaet · settings · notification · finance · public-portal`.

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
- Soft delete: `isDeleted` + `deletedAt` — never hard delete.
- Enums: `Object.freeze({})` — exported and reused across backend controllers/validators (the frontend mirrors the same values in its Yup schemas).
- Auto-increment refs via `counter` model. `{ timestamps: true }` on every schema.
- Compound indexes at schema level for frequent query patterns.

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
/api/settings       /api/notifications  /api/finance
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
