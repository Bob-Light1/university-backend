# Administrator portal browser audit

Correction follow-up (2026-10-01): **AP-01 through AP-09 are corrected and verified**.
The canonical browser harness passes 114/114 checks and exits with code 0; the
backend suite passes 1,610 tests across 76 suites. Implementation, regression
proofs and coverage boundaries are recorded in
[the correction note](features/admin-portal-audit-corrections.md).

| Finding | Verified correction |
| --- | --- |
| AP-01 | Result reads and writes preserve campus context. Closing A locks 18 results and generates six transcripts; all B results and transcripts remain unchanged. Campus-less global closure is rejected. |
| AP-02 | Campus announcement lists are scoped and creation persists on the selected campus. |
| AP-03 | An unconfigured plan displays the translated label. |
| AP-04 | Mentor, staff and partner creation persists with the selected campus. |
| AP-05 | Examination lists and totals match the selected campus. |
| AP-06 | Blank optional fee/payment dates submit; a 10,000 fee and 2,500 payment leave 7,500 outstanding. |
| AP-07 | Document list queries and server filtering preserve campus context. |
| AP-08 | Mentor/staff lists honor global actors' selected campus and retain identity scope for campus actors. |
| AP-09 | Lock, unlock and restore require ten trimmed reason characters; labels and errors are translated in all ten locales. |

The September 27 observations and coverage matrix below are historical evidence,
including their references to then-open AP findings. This table supersedes those
defect statuses. Unexecuted combinations and external integrations remain outside
this bounded correction pass; full administrator acceptance is incomplete.


Date: 2026-09-27. Status: audit pass recorded with defects; full administrator acceptance remains incomplete.

## Scope and method

The owner requested a real administrator journey starting at the login form and
selected a local environment with synthetic data. This audit uses Chrome through
Puppeteer, the current compiled frontend, the actual Express application and a
disposable MongoDB replica set. No authentication token is injected into browser
storage. Login is performed by typing into the public administrator form.

Backend branch: `feat/fee-receipts-and-reminders`. Frontend branch: `main`.
Existing uncommitted changes in both repositories were preserved. Application
source, dependency manifests and production configuration have not been edited.

The fixture initially contains 283 documents across 31 collections and two
campuses. The seed verifier passed. Test operations create additional synthetic
records. Partner applications were added through the partner service into the
guarded, audit-owned disposable database; public portal intake is not validated.

The test runtime starts outside the repository directory so legacy dotenv calls
cannot load repository secrets. AI and notification delivery integrations are
unconfigured. Image upload was attempted using a synthetic one-pixel image and
failed at the Cloudinary dependency. No successful upload is claimed.

The initial fast navigation pass exhausted the normal API limit of 100 requests
per 15 minutes. Subsequent scenarios reset that counter through a control route
implemented only in the temporary test server. Authentication, business guards
and route-specific limiters remain enabled. This is not a rate-limit/load test.

## Confirmed findings

Each listed defect was reproduced three times, except the cross-campus semester
closure write below, which has one explicit before/after proof. Campus-context
findings concern the selected campus shown to an administrator who already has
global authorization; they do not establish unauthorized access by a scoped role.

### AP-01 — Results ignore the campus selected in the URL

On `/campus/:campusId/results`, both campus A and campus B display 55 results.
The fixture expects 35 live results for A and 20 for B. Actual browser requests
are `GET /api/results?page=1&limit=50`, without a campus parameter; responses
contain results from both campuses.

`frontend/src/campus/components/results/ResultManager.jsx` derives campus identity
from the authenticated user, which has no campus for ADMIN, then invokes
`useResult('manager')` without context parameters. The backend already supports
an explicit `campusId` query for global roles.

Impact: the campus results view and its totals describe the entire platform.
A browser click on **Lock Semester** from campus A also modified campus B. The
request contained only academic year `2025-2026` and semester `S1`. Before the
click, A had 18 unlocked live S1 results and B had 10. Afterwards all 28 were
locked: A 18 and B 10. The response reported 28 modified records, 10 generated
transcripts and zero errors. Read-only database aggregation verified the before
and after state in the guarded audit-owned disposable database.

**High priority:** this is a cross-campus write caused by losing the selected
context, even though ADMIN is globally authorized. Preserve campus scope for
listing, overview, reference selectors and every write/batch action. The API must
also apply the authorized requested campus to closure operations. A separate S2
closure returned HTTP 200 with 27 records and 10 transcripts.

### AP-02 — Campus announcement context is missing for ADMIN

The campus A announcement screen displays campus B announcements. Creating an
announcement there returns HTTP 400, `campusId is required.` Global creation from
`/admin/announcements` with an explicit campus selection succeeds.

`frontend/src/components/announcements/AnnouncementAdmin.jsx` supplies campus
context only when `isAdminGlobal` is true. Its campus-mounted instance supplies
neither the selected campus in list queries nor the required campus in creation.

Impact: mixed-campus lists and an unusable create action for administrators
working inside a campus. Follow-up must cover both list and create behavior.

### AP-03 — Unconfigured offers display a translation key

On `/admin/entitlement`, a campus whose plan is null displays
`features.pilot.planOption.null` alongside its unconfigured state. The issue
persists after reload and after another campus is successfully assigned Premium.

Relevant frontend: `src/admin/components/campuses/EntitlementEstate.jsx`.
Impact: a technical key appears in the commercial plan column.

### AP-04 — Mentor, staff and partner creation omit the required campus

Creating either entity from campus A returns HTTP 400, `schoolCampus is required.`
These forms were submitted three times with valid synthetic identity fields.
Partner creation also failed three times with `schoolCampus is required for
ADMIN/DIRECTOR.`
`MentorForm.jsx`, `StaffForm.jsx` and `PartnerForm.jsx` build creation payloads
without `schoolCampus`.
No mentor, staff or partner record was created by these failed attempts.

### AP-05 — Examinations ignore the selected campus

Campus A displays all three fixture sessions, including `Exam session B1`, instead
of its own two. Three reloads request `GET /api/examination/sessions?page=1&limit=10`
without campus context. `ExaminationManager.jsx` derives the campus from the ADMIN
identity rather than the route. Write workflows still need separate validation.

### AP-06 — Optional finance dates silently prevent submission

The fee and payment forms initialize `dueDate` and `paidAt` as empty strings.
Their manual Yup validation uses `date().nullable().optional()` without an empty
string transform. Clicking submit three times in each otherwise valid form sends
no POST and displays no validation message. Entering the date through the same UI
allows HTTP 201 immediately. Relevant files: `financeSchemas.js`,
`FeeFormDialog.jsx`, `PaymentDialog.jsx` in the frontend.

A dated fee of 10,000 XAF and partial payment of 2,500 XAF succeeded. Reloading
showed 7,500 XAF outstanding. Its receipt endpoint returned a 47,187-byte PDF.
The issue concerns the optional-date path, not the recorded payment arithmetic.

### AP-07 — Document lists ignore the selected campus

Three reloads of campus A's documents request `/api/documents` without campus
context and return 12 live documents across A and B. `DocumentManager.jsx` reads
the route campus for its form but calls `useDocument('manager')` without it.

### AP-08 — Mentor and staff lists ignore an explicit campus query

Three reloads of each page send `campusId=<A>` to `/api/mentors` and `/api/staff`,
yet each response contains all three fixture records across A and B instead of
A's two. Unlike AP-01/05/07, the browser does provide the campus parameter here.
The displayed total and campus-specific KPI therefore disagree. Their backend
controllers derive the list filter from `buildCampusFilter(req.user)` without
applying the requested campus query.

### AP-09 — Document locking labels a required reason as optional

Three attempts to lock the newly published audit document displayed `Reason
(optional)`, accepted an empty field, and returned HTTP 400: `A reason of at least
10 characters is required to lock a document`. `DocumentDetailDrawer.jsx` sets
`required: false` for this action while the workflow controller requires a reason.
The restore action has the same source-level mismatch; only locking was replayed
three times with an empty reason. Label and minimum-length validation should agree
with the server. With a valid reason, lock, unlock, archive and restore all returned HTTP 200,
and their expected states were visible after each reload.

## Evidence obtained

- Current frontend production build passed; the existing large-chunk warning remains.
- Real administrator login passed; anonymous protected-route redirect passed.
- All 13 administrator routes rendered, plus all 22 campus routes reachable by
  ADMIN. Route rendering alone does not validate the operations inside each page.
- Display-name changes and notification preferences persisted after reload.
- Administrator and director account creation passed. Suspension, deactivation
  and reactivation returned successful responses for both account types.
- Class, subject, student, teacher and parent creation passed and persisted.
  Pending account activation was not exercised through an external channel.
- Personal language (French/English) and theme (dark/light) persisted. A mobile
  snapshot was captured; no full responsive visual review is claimed.
- Staff-role creation with `students.read`, editing and deactivation passed;
  creation and deactivation were checked after reload.
- Password change passed, a fresh browser context authenticated with the new
  password, the original test password was restored, and logout returned a
  protected administrator route to the login form.
- Campus search, archive and restore passed. Premium-plan persistence passed.
- FAQ, testimonial and course-preview creation, editing and deletion passed.
  Publish controls were exercised; stronger persisted-state assertions remain.
- Global announcement creation, publication, pin/unpin, archive and soft delete
  passed. Permanent deletion passed through the actual impact/phrase/password/
  reason dialog. A populated campus was correctly blocked from permanent deletion.
- Partner application approval and rejection passed with the review note visible.
- Competition creation, editing, activation/deactivation, closing and deletion
  passed. No qualifying quiz attempts were present, so winner-ranking correctness
  is not established.
- Finance creation and partial payment passed with explicit dates; balances and
  a PDF receipt were verified. Income creation and expense creation/approval/
  payment passed; a paid expense no longer exposed an edit control.
- Finance module freeze and reactivation persisted; the module was left active.
- Catalog course creation, submission and approval passed; approved state persisted.
- Document creation/publication/lock/unlock/archive/restore passed with required
  reasons supplied; states were recorded after reload. Empty-reason defect: AP-09.
- All six academic PDF preview types returned PDF data after supplying their
  prerequisites. The transcript returned expected 404 before semester closure,
  then succeeded for the closed fixture period. Seven PDFs (six academic plus
  payment receipt) yielded nonempty text with `pdftotext`; layout was not reviewed.
- AI campus selection worked and the actual service returned the expected 503
  unavailable state. Successful AI operations require a configured AI service.
- The new-campus wizard reached the image step. Creation cannot be validated
  end to end without a working image-upload dependency in this local runtime.

## Coverage matrix and remaining work

| Area | Browser evidence | Remaining boundary |
| --- | --- | --- |
| Access and account security | Real login, anonymous redirect, password change/fresh login/restore, logout | Recovery/activation delivery needs external channels |
| Global accounts | ADMIN/DIRECTOR creation and status transitions | Exhaustive invalid-input and account deletion combinations |
| Profile and preferences | Name, notification preference, French/English, light/dark persisted | Other locales, full accessibility and viewport matrix |
| Campuses and offers | Archive/restore, Premium plan, Finance freeze/reactivation persisted; populated deletion guard | New campus image upload blocked; quota/override expiry matrix |
| Public content | FAQ/testimonial/course-preview CRUD; publication controls exercised | Stronger publication persistence assertions |
| Announcements | Global creation and full lifecycle including guarded permanent deletion | Campus creation blocked by AP-02; delivery integrations |
| Applications and competition | Approval/rejection with note; competition lifecycle | Public intake and qualifying winner ranking |
| Students/teachers/parents | Creation and reload persistence; filters/search exercised | Full transfer, archive/restore and relationship matrix |
| Classes/subjects | Creation and reload persistence | Full edit/archive/bulk combinations |
| Mentors/staff/partners | Read lists and three creation attempts per form | Creation blocked by AP-04; list defects AP-08 for mentors/staff |
| Roles | Create, permission selection, edit, deactivate; reload checks | Enforcement after logging in as STAFF is outside ADMIN journey |
| Courses | Create, submit, approve; approved state persisted | Rejection, versioning, prerequisites and resource combinations |
| Results | Two-campus read proof; semester closure and cross-campus write proof | AP-01 blocks safe campus-specific validation; detailed corrections/batches |
| Examinations | List and selected-campus proof; available controls inventoried | AP-05; enrollment/grading/appeal workflow; New Session is intentionally disabled for ADMIN |
| Finance | Fee, partial payment, balance, PDF; income; expense approval/payment; paid editing unavailable | AP-06 empty-date path; complete refunds/cancellation/reminder/ledger matrix |
| Documents | Create, publish, lock/unlock, archive/restore and reason validation | AP-07/AP-09; upload/share/version/deletion combinations |
| Academic printing | Six PDF preview types; transcript after semester closure | Batch queue completion and rendered layout review |
| Schedule/GAET | Read-only screens rendered; no create/generate control for ADMIN by design | Date-specific list/calendar results and complete generated timetable coverage |
| Attendance | Student/teacher/postponement entry screen rendered | Date-filtered detail/correction workflows |
| Delivery log | Empty-state rendering | Replay requires a synthetic delivery history and configured channel for successful delivery |
| AI | Campus selection and expected HTTP 503 unavailable state | Successful chat/search/advisor tests require an AI service |
| Campus system settings | Available tabs inventoried | System configuration explicitly says “coming soon” |



Navigation covered all 35 listed routes, with the substantive workflows above.
This does **not** certify every operation or input combination. Confirmed defects
and unavailable integrations prevent an all-green administrator acceptance verdict.
Screenshots were captured as artifacts; their pixels have not been independently
reviewed because the image-view tool was blocked by the local sandbox failure.

At the end of the September 27 audit, no application fix had been implemented
for AP-01 through AP-09. See the September 30 correction follow-up above. This audit does
not complete CH-2, CH-4 or CH-5 in [the QA strategy](QA_TEST_STRATEGY.md), change
product delivery status, or replace its acceptance process. Existing frontend
lint debt and historical course-check failures remain outside this work.

## Local evidence and harness notes

The audit-owned runtime was stopped cleanly after collecting the evidence.

Evidence is under `tests/fixtures/.generated/admin-portal-audit-2026-09-27/`:
`results.json`, DOM snapshots and PNG screenshots. The runtime log is
`tests/fixtures/.generated/admin-portal-runtime.log`. Generated fixture account
exports are private test artifacts and must not be copied into documentation.

Temporary scripts: `/tmp/admin-portal-server.cjs`, `/tmp/admin-portal-driver.cjs`,
`/tmp/admin-portal-audit.cjs` and `/tmp/admin-stage-*.cjs`. The server owns the
ephemeral database and ports 5000/5173. The browser endpoint is stored locally in
`/tmp/admin-portal-browser-endpoint`. Script copies are archived under the
evidence directory in `harness/`. Some stages depend on previous UI/database
state; this exploratory harness is not a new deterministic CI suite.

Raw results include superseded harness failures: early navigation sampling,
incorrect catalogue nesting, API throttling, fetch property/method confusion,
public-intake setup without portal configuration, and incorrect endpoint/DOM
selectors, insufficient waits for deferred tables, confusion between a drawer
and a confirmation dialog, and a pending-course label assertion. Transcript 404
checks before closure are a missing prerequisite, not a product defect. These
are not additional confirmed product defects. Corrected stages
and the explicitly reproduced findings above are the interpretation of the
evidence; raw PASS/FAIL totals must not be used as a release score.
