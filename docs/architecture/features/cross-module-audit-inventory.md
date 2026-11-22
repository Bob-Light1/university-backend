# Cross-module audit emitter inventory

Inspected on 2026-11-12 against backend `main` at `95920ac`, with a clean starting
tree. This is the implementation inventory for
[phase 1-B row 8](cross-module-audit.md), not evidence that any emitter exists.
The owner's November 12 decisions include approved/paid expenses, submitted/admitted
dossiers, received income, student payments and validated commissions.

## Reading the inventory

An effective record has crossed its publication or approved business boundary.
Eligibility survives withdrawal, archival, cancellation and return to draft.
Evaluate the **persisted before-state**, not just the requested after-state.
The first boundary crossing establishes eligibility; subsequent changes are events.
Creating a payment also changes an existing debt and therefore needs an event for
that effect, even though the payment itself is new.

The paths below are relative to the backend root. Follow the named functions, not
line numbers that will move during implementation. Every writer marked here still
needs a transaction/session review and executable acceptance evidence. An existing
transaction or embedded history is not proof of unified-journal coverage.

## Academic records

| Source and eligibility evidence | Inspected writers and callers | Required integration and regression |
|---|---|---|
| `Result`: `publishedAt`, `PUBLISHED` or `ARCHIVED` | `modules/result/controllers/result.workflow.controller.js`: `auditCorrection`, `archiveResult`, `lockSemester`; `modules/result/controllers/result.crud.controller.js`: `deleteResult` | Service-owned read/write/event transaction; retain `auditLog`. Corrections also accept `SUBMITTED`, which alone is not publication. No-op field assignments produce no new journal event. Record each result actually locked, not an aggregate count or every matched row. |
| Result publication and derived risk | `publishResult`, `publishBatch`; `modules/result/result.repository.js`: `setDropoutRiskScore` | First publication establishes eligibility. Subsequent persisted risk changes need a named system actor and their own atomic event; do not falsely attribute asynchronous computation to a later viewer. Include computed grade fields from the persisted result, after model hooks. |
| Retakes | `publishResult` reads the original through `findResultById` | **Correction to the initial inventory:** the inspected branch does not write the original result. Do not invent an original-result mutation event. Its comments about replacement and the aggregation's `retakeOf: null` rule need a separate regression before any grading-rule change; this inventory does not change that rule. |
| `FinalTranscript`: `VALIDATED`, `SEALED`, `validatedAt` or `sealedAt` | `modules/result/controllers/result.analytics.controller.js`: `validateTranscript`, `signTranscript`; `modules/result/result.service.js`: `signTranscriptByParent`; `modules/result/models/final-transcript.model.js`: `signByParent` | Initial validation establishes eligibility. Signature and later state changes require the same transaction as their event. Cover the authenticated parent facade and the public signature route separately. The public `signedBy` body value is **not authenticated actor identity**. |
| Existing effective transcript regeneration/ranking | `lockSemester` → `generateTranscriptForStudent` → `FinalTranscript.generateForStudent`; `listTranscriptsForRanking` → `bulkSetTranscriptRanks` | The upsert can overwrite an existing validated/sealed transcript with `DRAFT`; ranking can also modify existing transcripts. Freeze eligibility from the before-state. Record actual subjects/average/rank/status changes; do not silently claim the workflow protects validated snapshots. Preserve currently reported partial-batch outcomes unless a separately specified fix changes them. |
| Transcript verification token | `FinalTranscript.generateVerificationToken` | Method exists, but the repository search found no caller; validation generates its token directly. Do not count an unreachable method as a covered runtime emitter. If used later, record only token presence/rotation, never the token. |
| `ExamGrading`: `PUBLISHED` or `publishedAt` | `modules/exam/controllers/exam.appeal.controller.js`: `resolveAppeal`; `modules/exam/exam.repository.js`: `updateGradingById`, `updateAppealByIdPopulated` | Currently two separate writes. Re-read scoped grade and appeal in one transaction; validate their campus/student/session relationship and score bounds. Commit grade, appeal and event together. A rejected/no-score appeal does not fabricate a grade change. Preserve appeal metadata as a related record. |
| Exam certificate | `modules/exam/controllers/exam.certificate.controller.js`: certificate generation | Issuing a token mutates a published grade. Record issuance without the `certificateToken`; repeated requests that return the existing token produce no mutation event. |
| Grading before publication | `modules/exam/controllers/exam.grading.controller.js`: `gradeSubmission`, `updateGrading`, second-grader assignment, second grading, mediation, `publishGrades` | Existing status guards restrict these paths to earlier workflow states. Keep them in boundary tests so an alternate grading route cannot bypass publication eligibility. First publication itself is not a post-publication correction. |
| `ExamSession`: `publishedAt` or `SCHEDULED`/`ONGOING`/`COMPLETED`/`POSTPONED`; cancellation needs prior-publication evidence | `modules/exam/controllers/exam.session.controller.js`: `_transition`, start/complete/cancel/postpone/reschedule; `modules/exam/controllers/exam.schedule.helper.js`: `injectExamIntoSchedule`, `syncExamScheduleStatus` | Session changes and required student/teacher schedule mirrors share a transaction through owning facades. Current mirroring is asynchronous. Re-scheduling upserts existing mirrors and must not erase their provenance. Publish-time mirror creation establishes their eligibility. |

## Schedules and generated timetables

| Source | Inspected writers and callers | Required integration and regression |
|---|---|---|
| `StudentSchedule`: `publishedAt` or `PUBLISHED`; later `POSTPONED`/`CANCELLED` retain eligibility | `modules/student/controllers/student.schedule.controller.js`: create/update/publish/cancel/soft-delete; `modules/student/student.schedule.helpers.js`: `syncTeacherSchedule` | Student schedule is the canonical scheduling entity for its teacher mirror. One event describes a mirrored timing/status/assignment change, with related IDs. The source and mirror must commit together. `softDeleteSession` currently does not call the mirror helper; cover that path explicitly. |
| `TeacherSchedule`: independent teaching activity on an effective schedule | `modules/teacher/controllers/teacher.schedule.controller.js`: `openRollCall`, `submitRollCall`, `requestPostponement`, `reviewPostponement` | Roll-call/postponement mutations have their own events. `submitRollCall` currently updates student attendance summary asynchronously; include that summary in the same transaction and avoid a second duplicate business event. Postponement approval currently writes the teacher schedule; define and test the corresponding student-time/status update before claiming consistent calendars. |
| Mirror implementation | `modules/teacher/teacher.service.js`: `syncTeacherScheduleMirror`; student/teacher facades exposing reference-based upserts/updates | The existing helper catches failures and cannot establish atomic success. Add session-aware repository/facade support and propagate failures inside the transaction. Sequential operations within one session; retain parallel independent work outside it. Never infer actor identity from `lastModifiedBy` alone. |
| GAET publication | `modules/gaet/controllers/gaet.controller.js`: `publishSchedule`; student facade `createScheduleSession`; teacher mirror | Creates already-published schedules, sometimes with partial materialization. Establish eligibility on each successfully created row. Subsequent schedule edits use the same emitters as manual schedules. GAET guards refuse edits/regeneration/cancellation of a published constraint; do not invent an ongoing constraint-edit workflow. Failed first publication/revert is not a successful post-publication event. |
| Availability/workload and attendance records | Teacher availability upserts, workload snapshots, student attendance controllers | These do not acquire publication status merely by being in a schedule module. Pure availability/cache maintenance is outside this journal. Changes to the effective schedule's roll-call/attendance summary remain covered above; individual attendance-record history is not silently substituted for it. |

## Documents, announcements and courses

| Source | Inspected writers and callers | Required integration and regression |
|---|---|---|
| `Document`: `publishedAt`, `PUBLISHED`, `LOCKED`, or established published archive | `modules/document/services/document.service.js`: update/soft-delete; `modules/document/controllers/document.workflow.controller.js`: archive/restore/lock/unlock/mark-official | Map actual `campusId` to journal `schoolCampus`. Preserve legacy `DocumentAudit` and versions. Restore to `DRAFT` must not turn off future auditing. `markOfficial` currently assumes old value `false` and writes its audit separately; use the real before-state and suppress no-ops. |
| Version restore | `modules/document/controllers/document.audit.controller.js`: `restoreVersion` | Body/branding restoration, version snapshot, legacy audit and shared event commit together. Snapshot references remain valid under their existing lifecycle; the new journal does not copy private file locations or raw HTML. |
| Sharing and automatic lock | `modules/document/controllers/document.share.controller.js`: share creation and access; `autoLockIfOfficial` in document service | Creating a grant on an effective document changes its access policy: record grant ID/expiry/limit, never its token/hash/URL. Public access itself is excluded. If access causes an automatic lock, record that state change as a system operation, not an authenticated viewer action. Downloads, counters and `lastAuditEntry` must not recurse into the new journal. |
| Retention | `modules/document/document.retention.cron.js`: `runRetentionJob` | Currently updates the business record and appends `DocumentAudit` separately. Re-read eligibility and expiration inside a per-document transaction; append both ledgers atomically. Keep bounded, self-draining batches and report actual committed rows. No TTL/purge of audit events. |
| Document editable-field boundary | `updateDocument` currently spreads the DTO into `$set`; see `CLAUDE.md` §5.2 | Fix the documented assignment defect as part of emitter integration: callers cannot rewrite campus, eligibility, audit metadata or publication evidence. Check the ERP form/consumer contract. A journal that trusts an editable body campus would merely preserve the isolation violation. No fix is claimed by this design. |
| `Announcement`: `publishedAt` or current `published` | `modules/announcement/controllers/announcement.admin.controller.js`: update/publish/archive/pin/delete; `modules/announcement/announcement.repository.js`: `archiveExpired`, `unpinExpired` | Archived formerly published announcements remain editable and in scope. Draft-only archives with no publication evidence are not. Both sweeps must enumerate affected rows in bounded transactions, recording actual old/new values and a job actor. Preserve `deletedAt` versus lifecycle `archived` semantics. |
| Global `Course`: `APPROVED` or prior approved `approvalHistory` | `modules/course/controllers/course.crud.controller.js`: update/archive/restore; resource controller; `modules/course/course.repository.js`: `cloneAsNewVersion` | Approval, not `visibility: PUBLIC`, establishes the effective catalogue boundary: `listApproved` serves approved courses without a PUBLIC-only filter. Keep global scope. Journal approved mutable fields, resource changes, archive/restore and old-version `isLatestVersion` changes. A new draft version is not an edit to the old published content. Preserve the existing clone transaction. |

## Finance and admission

| Source and boundary | Inspected writers and callers | Required integration and regression |
|---|---|---|
| `Expense`: approved/paid; `approvedBy` is historical evidence after rejection | `modules/finance/expense.service.js`: `updateExpense`, `transitionExpense`, `deleteExpense`; finance repository | Approved expense edits, payment, later rejection and soft deletion are covered. Paid edits remain refused. Before-state and event must share the write transaction; preserve category validation and actual `schoolCampus`. |
| `Income`: `received` or evidence of earlier receipt | `modules/finance/income.service.js`: `updateIncome`, `deleteIncome` | Received/cancelled-after-receipt edits and deletion are covered. Creation defaults to `received`, establishing eligibility. The schema's campus is optional: a missing campus is **not evidence of global ownership**. Report unresolved legacy scope for controlled reconciliation; do not attribute it to the requesting administrator's selected campus. |
| `StudentFee` and payment effect | `modules/finance/finance.service.js`: `createFee`, `recordPayment`, `deleteFee`, `runOverdueJob`; repository guarded increment, payment insertion, `setFeeStatus`, `markPastDueOverdue` | A recorded debt is effective at creation. Each subsequent payment changes `amountPaid`/status and carries its payment ID. Replace increment/insert/compensating-decrement with one transaction retaining the guarded balance check; event failure must roll back all three. Overdue transitions are system mutations; reminder timestamps/counters are delivery bookkeeping, not new financial events. |
| `FeePayment` | Payment creation above; receipt reads | No ordinary update/delete workflow was found. Record its creation as a related effect of the debt mutation, with amount/currency/method/date; never double-count it as two payments. Receipt reads/downloads are excluded. Future correction/cancellation APIs must acquire explicit emitters. |
| `PartnerLead`: `dossier.submittedAt`, submitted/admitted/enrolled or reliable status-history evidence | `modules/partner/admission.service.js`: `transition`; `modules/partner/admission.enrollment.service.js`: `enroll`; lead status/archive aliases | Extend the existing admission transaction; keep optimistic revision and immutable submitted attachment snapshot. Enrolled retry is a no-op with no second event, student or commission. Capture student/commission IDs, not activation or delivery credentials. Rejection/abandonment does not erase prior eligibility. |
| Public repeat registration | `modules/partner/partner.service.js`: `upsertPreRegistrationLead`; repository `updateLeadById` | Existing deduplication can update an already-submitted lead's programme/contact/attribution fields without the admission transaction. Cover the path explicitly, retaining first-touch attribution. Actor is public/unverified, not the lead or partner identity asserted in the body. Contact changes are redacted in the shared journal. |
| `PartnerCommission`: `validated`, `paid` or `validatedAt` | `modules/partner/controllers/partner.commission.controller.js`: validate/pay/dispute/cancel; repository `updateCommissionScoped` | Initial validation establishes eligibility; later payment/dispute/cancel events use actual prior status in a conditional transactional write. Preserve partner/campus ownership and immutable `ruleSnapshot`. Pending commissions created during enrollment are related records, not already validated events. |
| Dossier access capability | Admission access rotation/revocation and private-file reads | Keep existing capability security and logs. Tokens, hashes, expiry credentials and private links never enter snapshots. No new general read/download tracking. Candidate submission establishes eligibility using capability provenance, not an asserted user role. |

## Public editorial content and permanent deletion

| Source | Inspected writers and callers | Required integration and regression |
|---|---|---|
| `Testimonial`, `FaqEntry`, `CoursePreview`: `isPublished` or retained prior-publication marker | `modules/public-portal/portal-admin.routes.js`; `modules/public-portal/controllers/portal-admin/portal-admin.factory.js`: update/toggle/remove; `makeContentRepo` in public-portal repository | These are actual publication workflows omitted by the initial status-only search. Cover edits, unpublication, republication and removal. Keep bilingual product content in its target languages. Preserve the explicit editorial hard-delete exception while making deletion and event atomic. AI ingestion runs after commit. |
| `CompetitionPrize`: `isActive` or retained prior-publication evidence | `modules/public-portal/controllers/portal-admin/competition.admin.controller.js`: update/toggle/close/remove; `modules/public-portal/competition.closing.cron.js`: competition closure | Journal prize/date changes, deactivation, winner assignment and removal. Manual and scheduled closure must share one transactional writer; no winner contact data in events. Preserve the editorial deletion exception. |
| `QuizQuestion.isPublished` | Model and repository `sampleQuizQuestions` / answer lookup; no live question-mutation route found in `portal-admin.routes.js` | A model flag alone is not a runtime emitter. Test future/import writers before claiming coverage; do not invent a missing CRUD route. Quiz answer keys must never enter the journal. |
| Danger-zone root/cascade/detach | `shared/lib/hard-delete/hard-delete.service.js`: `runTransactionalDelete`, custom GED executor; deletion registry | Inspect each actually affected eligible entity before removal or detachment and append its event in the same transaction. A root deletion count is not per-entity coverage. Preserve tickets, passwords, reasons, blockers and cascade caps. Audit events are `RETAIN` relations of campus and source deletion, never cascades. |
| Existing audit ledgers | `DocumentAudit`, `DeletionAudit`, result `auditLog`, lead `statusHistory`, course `approvalHistory` | Keep original records/consumers. A new event may reference an existing audit ID but must not clone a read/refusal into a successful mutation. Post-storage-cleanup `DeletionAudit.filesRemoved` enrichment remains valid in that ledger; it does not make new journal rows mutable. |

## Change projection rules

Each emitter must define an explicit field projection using its model and existing
editable-field constants. No request-body spread or whole-document serialization
is an event projection. The compiled schema inspection covered 15 principal models;
the tables also include editorial models and GAET callers. This is a source review,
not proof that all dynamic writers are intercepted.

- Retain typed old/new values for business states, amounts, currency, scores,
  ranks, dates, boolean controls and entity IDs. Preserve `null` versus an absent
  value; compare normalized persisted values, not input strings.
- Use field-change indicators for names/contact information, free-text content,
  notes, document bodies, attachments, meeting locations/credentials, URLs and
  quiz answers. Do not store plain values or unsalted hashes of those values.
  Record safe resource/version IDs and counts where they explain the operation.
- Include derived business fields affected by the same save, such as normalized
  score or debt status, in that event. Do not emit again for each schema hook.
- Exclude `_id`, `__v`, `updatedAt`, audit mirrors, download/print counters,
  ingestion state, snapshot caches, notification cadence and authentication
  credentials. These exclusions do not hide changes to business state.
- Unknown business fields must fail projection validation during integration;
  adding a model field requires an explicit included/redacted/operational decision.
  A changed field with equal normalized old/new values is not a mutation.

## Implementation checkpoints

1. Shared append-only event storage, session-required writer, index preparation,
   registry retention and disposable database rollback/immutability proof:
   implemented in the [storage/writer checkpoint](cross-module-audit.md#storagewriter-checkpoint--2026-11-12).
   No production source declarations or emitters are connected by this checkpoint.
2. Academic/document emitters, including actual before-state, public/system
   provenance, bulk operations and the documented GED assignment defect.
3. Schedule/exam mirrors and financial/admission transactions, keeping existing
   ownership, quota, payment-concurrency and revision guarantees.
4. Editorial writers and danger-zone cascades/detaches; prove no hidden publication
   path bypasses the journal. Reconcile legacy eligibility/scope reporting.
5. Consultation, export and settings; ERP consumer and ten locales; full ordered
   tests/audits/browser QA and manual-case registration.

These are checkpoints within row 8, not delivered sub-features or permission to
skip later steps. No backend emitter, API or frontend screen is implemented by
this inventory. No later roadmap phase starts.
