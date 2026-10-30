# Online admission — phase 1-B row 5

Date: 2026-10-23.
Last acceptance review: 2026-10-29.
Status: IMPLEMENTATION IN PROGRESS — synchronized consumers; acceptance gates remain open.

## Problem and scope

Complete the existing public pre-registration funnel with dossier attachments,
director/administrator admission, actual student creation on enrollment, and
candidate notification. The owner requests continued phase 1-B work. Row 13's
test foundation and row 14's source changes precede this work under
[roadmap §3](../ERP_ROADMAP.md#3--la-chaîne-des-phases-et-sa-règle-dordonnancement).
Their historical acceptance is not validation of this feature.

Recorded owner decisions, [D-R24](../ERP_ROADMAP.md#14--journal-des-décisions):

- Only `DIRECTOR` and `ADMIN` may pronounce admission.
- The campus manager prepares the dossier.
- This version has no automatic payment prerequisite.

No push, deployment, production database migration, automatic enrollment of
historical leads, WhatsApp integration, new commercial plan or phase 2 work is
included. Existing GED index rollout remains a release prerequisite under
[GED expiry safety](ged-expiry-safety.md).

## Approved owner choices — 2026-10-23

The owner explicitly answered all three questions while requesting continued
roadmap implementation. These choices supersede the earlier pending proposals.

| ID | Question | Approved choice |
|---|---|---|
| OA-1 | Who uploads dossier attachments? | Candidate through a private emailed link; campus manager can complete the dossier |
| OA-2 | Which attachments block dossier submission? | Campus-configurable requirements, with none required by default |
| OA-3 | Who finalizes enrollment after admission? | Campus manager, director or administrator |

The choices determine the public authentication surface, campus configuration
screen, validation gates and enrollment authorization. D-R24 still reserves
admission decisions to directors/administrators and adds no payment prerequisite.

## Bricks touched

| Brick | Responsibility |
|---|---|
| Backend | Lead workflow, dossier authorization and persistence, private file access, student creation, commission transaction, notifications and tests |
| ERP frontend | Existing lead pipeline and detail drawer, dossier preparation/review, enrollment form, role/feature controls, ten locale catalogs |
| Public portal | Candidate notification/intake contract; private dossier pages and server proxies for approved candidate uploads; all eight existing locale catalogs for changed UI |
| AI service | No change; applicant identity documents must not become ingestable content |

The roadmap's existing `B1·B4` row omits the current ERP workflow consumer.
`B2` is required: `src/services/leadService.js`, `src/hooks/useLead.js` and
`src/campus/components/partners/LeadDetailDrawer.jsx` currently submit every
transition, including admission and enrollment.

## Verified starting behavior

Repository inspection on 2026-10-17, without running the applications:

- Backend `main` started clean at `5d3a2af`; ERP `main` and portal `main` started clean.
  Portal foundation commit: `32118d0`. Course working tree is clean.
- `PartnerLead` uses `schoolCampus`, seven workflow statuses and status history.
  It has no student reference, attachment fields or deletion marker.
- `PATCH /api/partners/leads/:id/status` authorizes all three management roles.
  Its controller validates a transition against a prior read, then the repository
  updates without matching the previous status. Admission has no separate
  director guard. Enrollment writes the status before attempting a commission.
- `PartnerCommission` already has a unique index on `lead`. Direct leads have no
  referring partner and must remain enrollable without a commission.
- `Student` requires first/last name, birth date, gender, phone, username,
  password, campus and class. The lead's birth date, gender and class are absent;
  its phone is optional. Lead names can be longer than student names. Student
  email and username uniqueness are global; matricule is also uniquely indexed.
- Existing student creation uses activation mode (`pending` and an unusable
  random password); it validates the class/campus relation. The account facade
  issues an activation link/code after creation. Do not call a controller from
  the admission service or duplicate these rules in the partner domain.
- Public pre-registration returns `202` without a lead ID; the queue owns the
  deduplicated write. Email or phone resubmission is not proof of ownership.
  Repeated public submissions must never reveal dossier access credentials.
- GED has private local/authenticated Cloudinary storage primitives, but no
  applicant attachment facade. Its upload sanitizer returns the original PDF
  on parse failure; do not assume this proves an uploaded PDF is safe.
- Campus storage quota currently sums GED `Document.importedFile.sizeBytes`
  only. Separate applicant files would otherwise evade that accounting.
- Notification recipient types exclude `PartnerLead`. The notification service
  persists both template data and rendered bodies, so using it to email a bearer
  link needs an explicit credential-retention design. `groupKey` is not a unique
  delivery constraint.

These observations define implementation obligations below, not a completed
feature audit. The three ordered audits still follow implementation and tests.

## Implementation contract — 2026-10-23

The following technical choices implement the approved OA decisions:

- Preserve seven lead statuses. Submitting a complete dossier may advance either
  `new` or `contacted` to `dossier_submitted`. Admission remains director/admin-only;
  enrollment remains manager/director/admin-only. Every mutation checks the current
  status and expected dossier revision atomically. Terminal historical `enrolled`
  leads without a student are explicitly reported, never automatically reconciled.
- Store student linkage, dossier revision/submission snapshot and capability hashes
  on `PartnerLead`. Store immutable private file references in `AdmissionAttachment`
  (`schoolCampus`, `lead`, category, uploader, byte count, `deletedAt`). Categories
  are `identity`, `diploma`, `transcript`, `other`; campus requirements select from
  these values and default to an empty list. Draft files can be archived; physical
  removal requires the existing danger zone. Retained archived bytes remain charged.
- Management prepares student information, assigns a live same-campus class and
  chooses a username. Candidate access permits only their own dossier/files and
  submission, never student assignment, admission, enrollment or internal notes.
  Submission snapshots campus requirements; later configuration does not silently
  invalidate an already submitted dossier. Freeze draft edits after submission.
- A 256-bit random capability lasts 72 hours, is revocable/reissuable and stores
  only its SHA-256 hash on the lead. Email links carry it in the URL fragment,
  never in a query string. The portal exchanges it into a secure HttpOnly,
  SameSite cookie; backend requests carry it in an authorization header. Treat
  bearer replay within its lifetime as possession of the same limited capability;
  it is never an ERP authentication token. Never return it from public intake or
  management/partner lead reads. Resend requests always answer uniformly and send
  only to the stored email of an existing lead after queue persistence.
- Authorize the capability and resolve portal entitlement before multipart parsing.
  Accept passive PDF, PNG and JPEG only, at most 5 MiB/file and ten live files per
  dossier. Reject unreadable/encrypted/active PDFs and failed image normalization;
  never retain the original as a sanitizer fallback. Force private downloads.
- Use the document facade for storage. Serialize campus quota checks with database
  writes and include retained admission files in storage usage. Add attachment and
  lead/student references to the danger-zone registry; add no business-record TTL.
- In one MongoDB transaction, create a pending student, advance the admitted lead,
  create/link the optional commission, issue activation and persist notification
  intent. No provider call occurs in the transaction. The existing delivery worker
  sends after commit; an idempotent enrollment retry returns the same student.
  Direct leads create no commission. Activation credentials are returned once to
  management, with delivery/reissue status, and never enter lead projections.
- Notification bearer links use authenticated encryption at rest, with redacted
  ordinary log snapshots. Only the delivery path and the recipient's own inbox
  decrypt them. This also applies to `account.activate`, whose existing plaintext
  notification snapshot must not be reused for new admission links. Reuse the
  existing notification retry worker and record SMTP absence as `skipped`.

The exact endpoint list and response/error constants are recorded alongside the
implementation below before consumers are wired. No new commercial key or
deployment is introduced.

## Existing management surface to complete

Retain the existing seven status values and normal response envelope. Freeze
statuses, valid transitions, roles, dossier categories, limits and error codes
as exported backend constants; clients mirror the contract with parity checks.
Use the existing transition endpoint where compatible; do not leave an older
status route as a bypass around the new enrollment or admission rules.

Proposed management surface:

- Existing lead reads expose authorized dossier metadata and the linked student
  summary to management roles. Partner self-service gets an explicit projection
  without private applicant files, enrollment data or access credentials.
- A dossier preparation mutation supplies validated student data and, depending
  on OA-2, the campus requirement snapshot used on submission.
- Upload/download endpoints accept a lead ID plus an attachment ID. Authorization
  resolves the lead and campus before file processing; clients cannot submit a
  storage key, provider URL or alternate campus to select a file.
- The enrollment transition accepts a validated student assignment and optional
  tuition basis for commission calculation. This basis is not a payment check.
- Errors distinguish invalid input, incomplete dossier, forbidden decision,
  conflicting transition, duplicate student identity and exhausted quota.
  Use `sendError`/validation helpers and existing feature error codes; freeze
  exact new names and payloads before writing consumers.

If candidate access is selected, add a separate limited dossier capability,
never an ERP login or a guessable lead ID. Issue access only to the stored lead
email after the queued write exists. Resends return a uniform response and must
not replace the destination with an unverified submitted address. Use expiring,
revocable credentials, bounded requests/uploads and explicit safe projections.
Finalize token lifetime, exchange/cookie transport, replay behavior, and how mail
delivery avoids retaining raw credentials in ordinary notification logs before
adding routes. Preserve `202`, silent deduplication and first-touch attribution.

## Campus scope and entitlement

Management uses `buildCampusFilter` through a local wrapper. A scoped actor's
campus comes from authenticated identity; global actors act on the campus of
the resolved lead. A selected class must be live and belong to that campus.
Partner self-service retains both campus and partner ownership and cannot
prepare, decide, enroll or retrieve applicant files.

If OA-1 includes candidate access, derive the campus and lead from the verified
capability. A campus slug, referral code, email or phone is not authorization.
Public access retains `resolvePortalCampus`: hidden is indistinguishable from
absent, and read-only permits authorized reads while refusing dossier mutations.

Inherit the existing `partner` key for the management funnel and `public-portal`
for public intake. No new sellable key or plan. Review dependency declarations
for the new student/document facade calls and gate writes at their effective
campus; preserve the documented global-role governance bypass. A private file
storage primitive must not accidentally require making applicant records public
or indexable by the GED/AI listing.

## Data, deletion and file lifecycle

Proposed expand-only changes: linked student on the lead, validated enrollment
data, dossier revision/history and private attachment metadata. Choose embedded
metadata versus a new model after OA-2; record campus teardown/deletion behavior
in either case. Existing `abandoned` is a workflow state, not a canonical
soft-delete marker. Do not pass `PartnerLead` to `notDeletedFilter` as if it had
one, and do not add a TTL to business records.

Use the document facade for private storage operations or extract an appropriate
shared primitive; never import another module's internal storage files. Bound
attachment types/count/bytes, check content and file type, and stream downloads
with safe filenames and cross-origin headers. Retain provider-neutral references,
charge actual bytes to campus usage, and preserve archived file metadata/history.
Permanent removal of persisted business attachments must use the hard-delete
registry/guards/audit. Clean up an uncommitted uploaded object on failed writes;
distinguish that compensation from deleting an accepted business attachment.

Historical `enrolled` leads may have a commission and no student. The expand-only
migration must report this state without fabricating students, changing status
history, relinking an unrelated existing student or recalculating commission.
Surface the unresolved state clearly; any historical reconciliation needs its
own explicit selection and validation.

## Enrollment consistency and notifications

1. Validate the actor, current status, dossier revision and complete student data.
   Do not synthesize birth date, gender or class, truncate names silently, or
   silently attach an existing account based on email.
2. Resolve class/campus and quota rules through facades. Extract reusable student
   creation behavior below the HTTP layer rather than copying generic-controller
   logic. Use session-aware repository calls and concurrency-safe identifiers;
   `count + 1` alone is not a concurrency guarantee for matricule generation.
3. In one transaction, create the pending student, conditionally advance the lead
   from `admitted`, record history/student linkage, and create/link any commission.
   Roll back all business changes together. Test concurrent/retried requests and
   quota races against a disposable replica set.
4. Within the transaction, persist activation through the session-aware account
   facade and enqueue encrypted delivery intents; send only after commit. Enrollment
   is distinct from activation: a created student remains `pending` until they
   choose their password. Return delivery/reissue information without exposing
   a student's password or credentials in lead reads or partner responses.
5. Notify the candidate of admission/enrollment with localized templates and
   explicit delivery status. Resolve the pre-student recipient contract below
   the notification facade. Persist retryable delivery intent without sending
   mail inside a retried database transaction. A failed send must not roll back
   enrollment or cause another student/commission on retry. Reuse the current
   delivery worker where feasible; SMTP absence must be reported honestly.

## Eleven-registry design review

This records intended work; each row must be checked against the final build.

| # | Registry | Expected action |
|---|---|---|
| 1 | `app.js` | Reuse existing partner/public mounts; verify route ordering and all new endpoints |
| 2 | Module facades | Partner admission orchestration; student creation API; document private-file API; notification recipient/delivery API as needed |
| 3 | Feature constants | Reuse keys; inspect dependency edges and candidate write declarations |
| 4 | Hard-delete registry | Declare attachment lifecycle and student/lead references; preserve campus/partner blockers |
| 5 | Soft-delete overrides | No new override expected; confirm against final schema, derive filters for existing live models |
| 6 | Job registration | No new job planned; reuse notification retry, record any change explicitly |
| 7 | Fixture `COUNTS` | Add deterministic admission coverage through the existing fixture; update counts only where new documents are seeded |
| 8 | Localization catalogs | Candidate notifications plus changed ERP text in ten locales and changed portal text in eight |
| 9 | ERP services/navigation | Update lead service/hook/drawer and existing navigation guards; verify global and scoped routes |
| 10 | Course hooks | Check structural references and exercises; regenerate only if affected, write a lesson only for a new pattern |
| 11 | Engineering map | Update backend/consumer route and subsystem documentation with implemented behavior |

## Definition of done and validation plan

- [x] OA-1–OA-3 answered and exact contract frozen before dependent code.
- [x] Design updated from implemented behavior; expand-only migration has dry-run
      and disposable-database evidence, with no historical automatic conversion.
- [x] Complete backend and every affected consumer, environment wiring included
      (`FRONTEND_URL`, `PORTAL_URL`, `VITE_API_BASE_URL`, `ERP_API_URL` and mail/
      storage settings). No secrets or generated credentials in documentation.
- [x] Campus/ownership/deletion/entitlement rules and all eleven registries reviewed.
- [x] Repository, service, facade and route tests; role denial, cross-campus and
      same-campus partner isolation; incomplete data/files; direct/referred leads;
      concurrent requests, conflicts, rollback, quota and notification failure.
- [x] Reproduce current admission authorization and enrollment consistency gaps
      with meaningful regression checks before correction.
- [x] Feature audit, platform audit, then test audit in `CLAUDE.md` §12 order;
      every finding closed by a regression seen failing before its fix, every new
      test seen failing deliberately at least once.
- [ ] Full Jest, backend lint/audit, applicable fixture self-check and journey,
      course structural checks, ERP build/touched lint/locale checks, and portal
      test/lint/build/typecheck/audit. Record actual runs separately from history.
- [x] Browser QA in both themes, administrator/director and campus-manager roles,
      candidate flow if selected, and enabled/read-only/hidden scoped states;
      permanent assertions and inspected screenshots.
- [x] Engineering map, roadmap dashboard/phase row, applicable QA dashboard and
      repository handoffs updated; mark delivered only after all required checks.

## Current implementation and acceptance — 2026-10-23

Status: implementation in progress, **not delivered**. Backend, ERP and portal sources are synchronized in their own repositories.
The owner requests repository-specific checkpoint commits while the feature
remains in progress; this does not establish final delivery acceptance. No push,
deployment, production DDL or historical student conversion has run.

### Implemented HTTP contract

All paths below are relative to `/api`. Standard response envelopes and typed
`ADMISSION_ERRORS` live in `shared/constants/admission.constants.js`. Mutations
require the current non-negative `revision`; stale requests return 409. Enrollment
retries return the linked student without reissuing activation credentials.

| Surface | Method and route | Authorization / response |
|---|---|---|
| Management requirements | GET/PUT `partners/admission/config?campusId=…` | Management roles; scoped identity wins; globals must select a campus. PUT `{ requirements: [] }` accepts unique supported categories. |
| Management dossier | GET `partners/leads/:id/dossier` | Management campus scope; live and archived metadata, configuration/snapshot, historical-enrollment indicator. |
| Management files | POST/GET/DELETE `partners/leads/:id/dossier/files[/:fileId]` | Authorized before multipart; upload `{ file, category, revision }`, archive `{ revision }`; GET is a private forced download. |
| Management candidate access | POST/DELETE `partners/leads/:id/dossier/access` | Rotate/send only to stored email or revoke; response contains delivery summaries, never the candidate capability. |
| Business transitions | PATCH `partners/leads/:id/status` | `{ status, revision, note?, student?, tuitionFee? }`; admission only director/admin; finalization by management. |
| Public recovery | POST `public/admission/request-access` | Portal key, campus state and dedicated limiter; `{ email, campusSlug }`; uniform 202 for existing/unknown contacts, no provider call in the request. |
| Candidate dossier | GET `public/admission/dossier` | Portal key plus `Authorization: Dossier <capability>`; lead/campus derived exclusively from the capability; private projection. |
| Candidate files | POST/GET/DELETE `public/admission/dossier/files[/:fileId]` | Same capability, campus state and bounded upload; writes only while draft; metadata responses reload the full candidate dossier. |
| Candidate submission | POST `public/admission/dossier/submit` | `{ revision }`; target status is server-owned; atomically snapshots requirements/file IDs. |

`ADMISSION_INVALID_ACCESS` returns 410. `ADMISSION_NOT_FOUND` returns 404;
role denials return 403. Conflict, required-category, quota, duplicate-student and
historical-enrollment errors return 409. Invalid file content returns 422 and
oversized input returns 413. Validation errors use the common admission adapter.
The existing legacy status/archive paths delegate to the same transition service.

Browser transport: `/{locale}/admission#access=…` immediately removes the fragment
from history and exchanges it via same-origin POST for an HttpOnly/SameSite-Strict
cookie scoped to `/api/admission` (Secure in production). Local handlers forward
only an explicit candidate allowlist with the server-only portal key. Private
navigation/API responses bypass the service worker and use `private, no-store`;
metadata requests are never cached. The URL capability does not enter localStorage
or sessionStorage. Candidate mutations refresh after conflict/read-only refusals
and clear previously displayed data after 404/410. The eight portal locales and
ten ERP locales retain their own inventories; roadmap locale reconciliation is
still a separate item.

### Ordered feature and platform audits

The following findings were reproduced before correction; paths are permanent
regressions, while execution logs are temporary acceptance artifacts.

| Finding | Correction and red/green evidence |
|---|---|
| F1 — partner self-service inherited dossier/student fields | Explicit partner list/detail projection; real admission journey failed then passed. |
| F2 — Unicode download returned HTTP 500, then used inherited `no-cache` | RFC 5987 filename plus private `no-store`; both failures observed separately; real HTTP/unit replay passed. |
| F3 — multipart filename decoding corrupted non-Latin names | Recover valid UTF-8 decoded as Latin-1 without corrupting native names; `admission-files.test.js` failed then passed. |
| F4 — candidate retained stale revision/data after conflict/revocation | Actual component-handler tests failed for conflict and 404/410, then passed after refresh/clear; permanent browser scenario still awaits replay. |
| F5 — NextURL loopback normalization rejected the actual origin and accepted another local hostname | Compare browser Origin against the actual HTTP Host and request protocol, never X-Forwarded-Host. The real candidate session returned 403 before correction; two handler regressions failed before the fix, a forwarded-host mutant was rejected, and the restored portal suite passes 55 cases. |
| P1 — queued mail ignored revocation or a module frozen after enqueue | Recheck capability and emission state at delivery; two `notification-private` regressions failed then passed. |
| P2 — damaged ciphertext broke the entire recipient inbox | Per-row redacted fallback; regression failed then passed. |
| P3 — ordinary student imports bypassed new shared capacity/class rules | Shared pending creation callbacks and validated import mapping; real import/last-place race failed then passed. |
| P4 — guarded file removal left shared GED usage cached | Invalidate usage after provider cleanup; real archive/preview/delete/cache regression failed then passed. |
| P5 — locale `constructor` crashed intake normalization | Replace prototype-sensitive map lookup; real intake regression failed then passed. |
| P6 — recovery could expose contact existence through provider latency | Enqueue only; initial intake creates lead and durable encrypted invitation atomically. Access-service regression failed then passed. |
| P7 — encrypted mail could be redirected by editing stored destination | Authenticated encryption binds recipient, destination, campus, channel and template; regression failed then passed. |
| P8 — new upstream redirect advisories blocked dependency gate | Existing-range lock update 1.16.0 → 1.16.1; two real loopback tests fail on old version and pass on patched version; no new exception. |
| P9 — registry failure was interpreted as a clean audit with stale exceptions | Reject error/malformed reports and abnormal subprocess outcomes before reporting findings. Eight new `audit-gate.test.js` cases failed before correction and pass afterward; existing exceptions are retained. |
| P10 — restored registry access exposed body-parser/Zod findings and a withdrawn portal exception | Patch body-parser within Express's existing range and portal Zod within v4; retire the withdrawn braces exception. Preserve Zod 3 only in the unused BiDi parser, with explicit CDP launches, a real PDF/module-loading guard and a named removal condition. Current closeout evidence below distinguishes this exception from patched dependencies. |

Platform boundaries: admission charges retained archived bytes alongside GED
imports; it does not claim to redesign all pre-existing GED write races or its
known general DTO issue. No new cron or sellable feature key is introduced.
`partner.usesWhenAvailable` documents the new technical collaboration; the later
complete entitlement dependency-graph work remains separate. No provider is called
inside a transaction that MongoDB may retry.

### Test audit and current evidence

Seven targeted backend mutants (scope/revision, decision preconditions, positive
authority, plaintext snapshots, missing private rendering, unknown recovery and
permissive file fallback), nine portal transport mutants (origin, cookie, path,
validation, limit, binary, multipart, recovery credential and HttpOnly), and both
consumer vocabulary mirrors were deliberately broken and detected. Sources were
restored in `finally` blocks. Three component-state cases have observed red/green
evidence. Audit-finding regressions above have their own pre-fix evidence.

Actual current runs:

- Full Jest: 92 suites / 1,756 tests passed before adding the final ten consumer
  contract cases and two redirect cases. Their targeted suites separately pass
  10/10 and 2/2; final combined full replay remains required.
- Admission real-data journey: 40/40, on its owned disposable replica set; includes
  expand-only preparation twice, optimistic upload race, idempotent enrollment,
  direct/referred commission rules and rollback, quota/import races, ownership,
  snapshots, archive/guarded purge/cache and revocation. Base fixture remains
  307 documents / 39 collections; independent CH-0 acceptance is unchanged.
- Backend lint passes with 39 existing warnings; audit gate passes with its two
  existing named extract-zip exceptions. No additional exception is introduced.
- Clean backend mutation replay: five suites / 38 cases, including both consumer mirrors. File normalization and
  HTTP tests passed after their fixes; final all-suite replay remains required.
- ERP build passes with explicit loopback API configuration; earlier touched lint
  and 190 locale/namespace combinations passed. Final replay follows final source.
- Portal: 8 files / 52 tests pass after mutations are restored; lint/typecheck
  pass. Earlier production build passed against an owned loopback public API;
  the latest component changes still need a fresh production build.
- Current pre-commit replay against synchronized sources: seven backend suites /
  44 tests; portal 52 tests plus lint/TypeScript; ERP touched lint and all 190
  locale/namespace combinations pass. These supplement the dated full runs above.
- Complete course guard passes 67/67 executable solutions, with 14 documented
  snippets skipped and cited references resolved. The first replay failed on
  route/capability-router classification and the newly introduced gender mirror;
  exact inventories and the declared live-schema mapping were corrected and
  replayed without weakening assertions. Course author review remains pending.
- Browser diagnostics did not establish acceptance. The first staged SPA lacked
  API configuration; its corrected build is ready. Both-role/theme/state replay
  and screenshot inspection remain mandatory.

### Eleven-registry implementation review

| # | Result |
|---|---|
| 1 | Existing `app.js` partner/public mounts retained; named config routes precede lead IDs, candidate router mounted under public admission. |
| 2 | Partner admission/access, student pending creation and document storage/usage exposed through existing facade services; notification session API reused. No cross-module internal imports. |
| 3 | Existing partner/public-portal keys retained; partner technical collaborators recorded; frontend navigation keeps its existing partner guard. |
| 4 | New attachment accessor/entity, campus blocker, submitted-file blocker and student lead blocker; provider cleanup goes through document facade and audit. |
| 5 | No override added: Attachment has only deletedAt/deletedBy; related model filters derive their actual conventions. |
| 6 | No job added; notification retry owns deferred external sends. |
| 7 | No base seed document/count change; admission constructs its scenario only inside the seeded disposable journey/browser database. |
| 8 | Notification templates in ten backend locales, changed ERP text in ten catalogs, candidate text/navigation in eight portal catalogs. |
| 9 | ERP service/hook/drawer/forms, portal proxy/session/page, and environment wiring prepared; actual consumer synchronization completed with checksum guards. |
| 10 | Structural figures/prose, review indices and generated hooks updated; complete course guard passes 67/67. No existing source path moved. |
| 11 | Backend engineering map updated; consumer map/contract/handoffs prepared with their sources. |

### Acceptance continuation — 2026-10-29

The current owner request resumes logical implementation and asks for scoped local
commits. Backend, ERP and portal started clean at their admission checkpoints;
no previous checkpoint changes remain to save. Current corrections are P9 above,
F5 in portal commit `0f2852f` (audit correction `eda0f81`, course inventory
`cef4cf0`), and browser-scenario synchronization/diagnostics:

- Wait for the specific MUI option and the previous menu's closure before the next
  selection. The first real pass failed class selection in all four role/theme
  combinations; the synchronized replay reached successful enrollment.
- Target the activation Dialog rather than the Drawer, which also has a dialog
  role. The next pass exposed this ambiguous selector in all four combinations.
  Reload enrollment afterward and assert the one-time activation dialog stays closed.
- Assert the candidate session response explicitly and skip dependent scenarios
  when initialization fails, preventing a cascade of orphan response waits.
- Preserve full journey error stacks for actionable diagnostics.

Checks actually run in this session:

| Check | Result |
|---|---|
| Full backend Jest | 94 suites / 1,776 tests pass, including eight new audit-failure cases. Initial sandbox run could not bind HTTP ports; the permitted loopback replay passed. |
| Backend lint | Pass, 39 existing warnings; touched scripts/tests also pass after final changes. |
| Admission real-data journey | 40/40 pass on its owned disposable replica set. Earlier startup/connection timeouts did not establish acceptance. |
| General API/data journey | 25/25 pass on its owned disposable replica set. |
| ERP production build | Pass with VITE_API_BASE_URL explicitly targeting the owned loopback API. No ERP source change was needed. |
| Portal tests/lint/TypeScript/build | Eight files / 55 tests pass; lint, types and rebuilt production portal pass. Two origin tests failed before the fix; the forwarded-host mutant failed, was restored and the 13-case handler replay passed. |
| Course references/solutions | 67/67 executable solutions pass, 14 snippets skipped, all cited paths resolve. The portal's exact source-line count failed at 4,358 vs 4,356; its assertion and prose were updated together without relaxing the guard. |
| Full browser replay | 202/202 pass (exit 0), including 28 admission checks. Actual compiled ERP and portal; ADMIN/CAMPUS_MANAGER, light/dark, three entitlement states, French desktop and Arabic mobile candidate flows. Screenshots visually inspected. |
| Dependency audits | Backend and portal gates cannot obtain a valid npm report. Backend now reports the network failure correctly; neither gate is accepted and no exception/dependency was changed. |
| Manual case payload | Five case bodies and all technical source references validate; registration/execution are separate gates. |

The eleven-registry review above still applies: no API route, model, module key,
job, fixture count, translation inventory or public facade changed in this
continuation. Registry 11 consumer/security references and the course's exact
inventory are updated with their respective changes. CH-* acceptance and the
roadmap estimate remain unchanged.

### Dependency closeout continuation — 2026-10-30

The next owner-requested continuation starts clean at backend `0f56abc`, portal
`0f2852f` and ERP `e1f85a2`. Registry reports now succeed and expose two blocking
roots plus a stale portal exception. The prior network diagnosis remains historical.

- [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828):
  update body-parser 1.20.6 → 1.20.9 within Express's existing dependency range,
  including its required qs/side-channel lock changes. A real split compressed
  request crashes the old gzip decoder with an unhandled error. Patched gzip and
  deflate preserve the decoded JSON, complete the request and answer a health probe.
  The vulnerable version is isolated in `/tmp`; the committed lock stays patched.
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5):
  update the portal's actual form dependency from Zod 4.4.3 to 4.6.7. Oversized
  bounded arrays/maps/sets must fail before visiting elements; bounded collections
  still parse. The oversized-array assertion fails against 4.4.3 and the patched
  permanent test passes. No portal exception is added.
- Backend Zod 3 exists only under Puppeteer's chromium-bidi 14, whose declared
  dependency is Zod ^3.24.1. Its parser is unused by the application. Explicitly
  select CDP in both PDF engines and retain this exact advisory under a named
  unreachable-path exception, with a removal/reassessment condition. The real
  regression launches both engines and renders an academic PDF while refusing
  Zod/BiDi module loading. The protocol assertion and both new audit-policy
  regressions failed before correction. No incompatible Zod-major override.
- Remove the portal's
  [withdrawn braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  from its production allowlist. Keep exception-policy coverage with an explicit
  synthetic fixture; a default production report has no exception. A returned high
  advisory still blocks the gate. Removing the final exception exposes acceptance
  of malformed findings/lock arrays; four assertions fail before the record-shape
  correction, then all 14 policy cases pass.

Prior closeout checks: 96 backend suites / 1,780 tests, backend lint (39 existing warnings),
17 targeted backend checks, nine portal suites / 64 tests, portal lint/TypeScript/
production build, and 18/18 portal browser checks pass. Both dependency gates pass:
three documented unreachable backend exceptions and none in the portal. This does
not claim zero npm findings. The first full browser replay finishes at 200/202:
AI tabs were counted before rendering, and the admission scenario checked a hidden
input instead of its disabled label. Await the rendered tab and the actual enabled
upload control, preserving all final assertions. The final replay result remains
unverified; the old handoff does not establish that a process is still running.
The first course guard fails on the changed exact inventories; F2.2/F2.4/F2.5 prose
and assertions are synchronized to 96 backend and nine portal suites, preserving
author-review status and dated mutation experiments. All 67 executable solutions
and cited references pass after synchronization.

Commit preparation on 2026-10-30 reruns the backend dependency gate successfully
with registry access. The audit-policy and compressed-request suites pass 16 tests.
The PDF regression initially times out at 95 seconds; an isolated run using the
already extracted Chromium binary passes in 4.2 seconds without changing its
assertions or timeout. This does not replace the full browser acceptance gate.
Touched backend files pass ESLint; portal tests pass all nine suites / 64 tests
and its dependency gate passes without exceptions. All 64 checked local
documentation targets resolve; whitespace checks pass in all three affected repos.
The course reference/solution replay also passes all 67 executables, with the
14 declared illustrative snippets skipped.

The existing eleven-registry review still applies: registries 1–9 need no change
to mounts, facades, sellable keys, deletion, jobs, fixture counts, translations or
consumer API wiring. Registry 10's exact test inventories and registry 11's security
reference are updated. No new course pattern, QA work item or product phase starts.
The current manual cases remain ERP-ADM-001–005; dependency maintenance adds no
separate business flow and does not establish their manual verdicts.

Hosted Workbench login now succeeds, but the available validation account's user
JWT still cannot see ERP multi-campus. The owner answered yes to granting editor
access; follow-up checks do not yet show membership. No service key, membership
elevation, campaign snapshot change or submitted-result mutation is used.

### Remaining delivery gates

The historical 2026-10-23 automatic-review quota rejection did not execute its
browser command. The current session's permitted local validations supersede that
execution blocker; it is not a standing ban or evidence of browser acceptance.

Both dependency gates now pass. Obtain the final browser replay result and
inspect captures, then register the existing Workbench cases after verifying
project-scoped editor/admin access. Keep row 5 in progress until the remaining
acceptance and case-registration requirements pass. Preparing cases or passing
browser checks does not record a manual campaign verdict.

Manual cases **ERP-ADM-001–005 are prepared, not registered or executed**. The
previous temporary payload disappeared between sessions. Their durable source is
[tests/manual/admission.cases.json](../../../tests/manual/admission.cases.json),
with [import instructions](../../../tests/manual/README.md). They cover file and
requirement handling, admission authority, enrollment/activation/idempotence,
scope/states and archive/permanent-delete safeguards. Hosted login now works, but
the validation identity cannot see the ERP project. Verify current editor/admin
membership and import through the existing Workbench CLI. Do not elevate access
with a service key, rewrite historical
campaign snapshots or infer manual verdicts from automated results.
