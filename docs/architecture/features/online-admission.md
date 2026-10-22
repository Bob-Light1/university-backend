# Online admission — phase 1-B row 5

Date: 2026-10-17.
Status: DESIGN IN PROGRESS — owner choices pending; no application changes.

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

## Owner choices required before implementation

These questions have been submitted to the owner. Recommendations below are
proposals, not approved product decisions. Do not implement a default merely
because no answer has arrived.

| ID | Question | Proposed choice | Alternatives |
|---|---|---|---|
| OA-1 | Who uploads dossier attachments? | Candidate through a private emailed link; campus manager can complete the dossier | Manager-only upload after receiving files outside the platform |
| OA-2 | Which attachments block dossier submission? | Campus-configurable requirements, with none required by default | Common identity/birth-document, diploma and transcript requirements; or manager verification without automatic requirements |
| OA-3 | Who finalizes enrollment after admission? | Campus manager, director or administrator | Director/administrator only |

The choices determine the public authentication surface, campus configuration
screen, validation gates and enrollment authorization. Implementation depending
on them waits for the answers.

## Bricks touched

| Brick | Responsibility |
|---|---|
| Backend | Lead workflow, dossier authorization and persistence, private file access, student creation, commission transaction, notifications and tests |
| ERP frontend | Existing lead pipeline and detail drawer, dossier preparation/review, enrollment form, role/feature controls, ten locale catalogs |
| Public portal | Candidate notification/intake contract; private dossier pages and server proxies if OA-1 includes candidate uploads; all eight existing locale catalogs for changed UI |
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

## Contract to finalize after OA-1–OA-3

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
4. After commit, issue activation through the existing account facade. Enrollment
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

- [ ] OA-1–OA-3 answered and exact contract frozen before dependent code.
- [ ] Design updated from implemented behavior; expand-only migration has dry-run
      and disposable-database evidence, with no historical automatic conversion.
- [ ] Complete backend and every affected consumer, environment wiring included
      (`FRONTEND_URL`, `PORTAL_URL`, `VITE_API_BASE_URL`, `ERP_API_URL` and mail/
      storage settings). No secrets or generated credentials in documentation.
- [ ] Campus/ownership/deletion/entitlement rules and all eleven registries reviewed.
- [ ] Repository, service, facade and route tests; role denial, cross-campus and
      same-campus partner isolation; incomplete data/files; direct/referred leads;
      concurrent requests, conflicts, rollback, quota and notification failure.
- [ ] Reproduce current admission authorization and enrollment consistency gaps
      with meaningful regression checks before correction.
- [ ] Feature audit, platform audit, then test audit in `CLAUDE.md` §12 order;
      every finding closed by a regression seen failing before its fix, every new
      test seen failing deliberately at least once.
- [ ] Full Jest, backend lint/audit, applicable fixture self-check and journey,
      course structural checks, ERP build/touched lint/locale checks, and portal
      test/lint/build/typecheck/audit. Record actual runs separately from history.
- [ ] Browser QA in both themes, administrator/director and campus-manager roles,
      candidate flow if selected, and enabled/read-only/hidden scoped states;
      permanent assertions and inspected screenshots.
- [ ] Engineering map, roadmap dashboard/phase row, applicable QA dashboard and
      repository handoffs updated; mark delivered only after all required checks.

## Current progress and next action

Only read-only repository inspection and this design draft are complete. Local
Markdown target/anchor checks and `git diff --check` pass. The design, roadmap
and handoff are included in the admission-design commit. No
application, fixture, migration, API or consumer code has changed; no application
suite or browser acceptance has run in this session. The roadmap row remains
`À FAIRE` until implementation starts, as required by `CLAUDE.md` §12.1.

Next: record the owner's OA-1–OA-3 answers here, finalize the conditional contract,
then implement bottom-up and follow the full delivery workflow. Sibling source
directories are outside this session's writable roots; if edits are needed,
prepare reviewable changes in a writable copy and use the normal scoped write
approval mechanism to synchronize them. This is not a pending owner product
decision or a reason to request blanket permissions now.
