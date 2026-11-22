# Cross-module audit journal

## Objective and approved decisions

Phase 1-B row 8 remains in progress. Existing-ledger deletion protection is
complete. The 2026-11-12 design milestone records the inspected mutation inventory
and v1 contract below; the subsequent [storage/writer checkpoint](#storagewriter-checkpoint--2026-11-12)
implements its internal foundation. Production emitters, eligibility preparation,
endpoints, export, settings and the ERP screen remain pending.

The owner approved on 2026-11-11:

- Permanent retention of audit events. A configurable consultation window must
  not delete older events or make archival an irreversible operation.
- The new journal tracks mutations after publication. General consultation and
  download tracking are outside this work item; existing document access events
  are preserved.

The owner further approved on 2026-11-12:

- Include mutations after expense approval/payment and dossier submission/admission.
- Include later changes to received income, student fee payments and validated
  commissions, including a payment's effect on the outstanding debt.

These choices extend the effective-business-state interpretation of publication;
they do not authorize changes to grading, financial or admission decision rules.
No production migration, deployment, pricing change or later-phase work is
performed. Independent CH-0 acceptance and target AI SLOs retain their gates.

## Bricks and current sources

| Brick | This increment | Subsequent row-8 implementation |
|---|---|---|
| Backend | Retention guards, inspected v1 design and shared storage/writer foundation | Production emitters, eligibility preparation, scoped consultation, settings and export |
| ERP frontend | Read-only review; no changed API, screen or environment variable | Shared management journal, settings and export; all ten locales under CLAUDE.md section 12 |
| AI service | No change | Review only if an actual consumer is introduced |
| Public portal | No change | Preserve existing ownership and candidate boundaries |

Verified existing sources are `DocumentAudit`, `DeletionAudit`, result
`auditLog[]` and partner lead status history. Their different shapes and
guarantees do not establish an existing unified journal. The deletion ledger
also updates `filesRemoved` after external storage cleanup; blocking all updates
would break that existing workflow. This increment does not change that write.

### Inspected mutation inventory — 2026-11-12

The [emitter inventory](cross-module-audit-inventory.md) identifies actual writers,
eligibility evidence, transaction gaps, mirror deduplication and regression
requirements. It includes exam sessions/certificates, GAET-created schedules,
public repeat registration, editorial publication flags and deletion cascades,
in addition to the original document/result/announcement/course candidates.

The original retake inventory overstated the code: `publishResult` reads the
original result but does not update it. The inventory now distinguishes that
fact from misleading comments. Transcript regeneration can overwrite an existing
validated record with draft data, and the public signature route does not verify
the submitted parent identity. These are integration findings, not fixes or
runtime exploit reproductions performed in this design milestone.

## Shared journal v1 implementation contract

This section freezes the technical baseline for implementation, subject to
correction from executable evidence. Only the explicitly dated choices above are
owner product decisions. Limits, field names and access defaults below are
engineering choices; they are not claims of an existing API.

### Event and source boundaries

Implement an `audit` module with a facade, repository, service and append-only
`AuditEvent` model. Business modules call its facade from their service transaction;
controllers do not create generic events from HTTP responses. Keep persistence
in repositories and source-specific business decisions in owning services.

Eligibility is sticky: once an entity has been published or made effective, later
archive, rejection, cancellation, unpublication or return to draft cannot exempt
it. Add an internal `auditEligible` boolean to applicable source models, set at
the first effective boundary and never reset or accepted from an HTTP DTO. Existing
reliable publication timestamps/history/current states also establish eligibility
until preparation has marked them. Initial publication alone creates no mutation
event; later republication does. Source creation already in an effective state
sets eligibility atomically. Related payment effects follow the inventory's rule.
Cloning a document or approved course into a **new draft entity** clears inherited
eligibility/publication evidence; restoring or regenerating the **same entity**
retains it. Test this distinction against the existing clone/spread paths.

Preparation must distinguish known-effective rows from uncertain historical
unpublished/draft rows. Report uncertainty rather than inventing an old actor,
date or event. Do not replay historical legacy logs as new successful mutations.
The UI must state the journal's actual coverage start and retain access to the
separate legacy histories. No assertion of complete retrospective coverage is valid.

| Stored field | Contract |
|---|---|
| `_id`, `schemaVersion` | MongoDB event ID; integer schema version `1` |
| `mutationId`, `operationId` | Server-generated UUIDs. Unique `mutationId` per logical entity mutation; shared `operationId` for correlated effects. Allocate outside a transaction retry, never from a caller-supplied identifier. |
| `occurredAt`, `createdAt`, `updatedAt` | Server dates; model timestamps required. `occurredAt` identifies event construction, not a certified database commit timestamp. No event update operation is exposed. |
| `module`, `entityType`, `entityId` | Closed backend enum values and raw ObjectId of the source. No populated dependency is required to retain/read history after source deletion. |
| `scope`, `schoolCampus` | `campus` with the actual source campus, or `global` with null campus for verified global collections such as Course. Missing scope on an otherwise scoped source is a validation failure, never automatic global access. |
| `partnerId` | Original owning partner ID where applicable; nullable for unassigned leads/non-partner domains. Ownership cannot be derived from a client query. |
| `actor` | `{ kind, id, role, source }`; kinds `user`, `system`, `capability`, `anonymous`. User identity comes from authenticated state. System source is a named backend operation/job; capability provenance comes from verified server context. Anonymous IDs/roles are null. |
| `action` | Closed enum: `update`, `archive`, `restore`, `delete`, `lock`, `unlock`, `sign`, `grant`, `transition`, `configure`. Domain operation name belongs in `source.operation`, not uncontrolled action strings. |
| `source` | `{ module, operation }` from backend-owned constants, never the submitted URL/body |
| `changes` | Non-empty array, at most 128 entries: `{ field, mode, hasBefore, hasAfter, before, after }`. `mode: value` uses allowlisted typed values; presence flags distinguish null from absence. `mode: redacted` retains only `field` and `mode`, omitting values/presence. |
| `reason` | Existing validated business reason where appropriate, bounded to 1,000 characters; otherwise null. Do not manufacture a reason requirement on every existing route. Preserve longer legacy reasons in their original ledger and reference that entry. |
| `related` | At most 50 typed source/legacy-audit references needed to explain the operation; no snapshots, credentials, raw URLs or arbitrary metadata bags. Larger operations use correlated per-entity events. |

Enums and limits live in backend frozen constants and are exposed through the
facade/metadata API; consumers mirror only what the contract requires. Projection
rules are in the inventory. Do not serialize a Mongoose document or `req.body`
directly. Raw tokens, token hashes, private links, answer keys, account credentials
and delivery configuration are prohibited. Unverified public signature or repeat
registration requests must never be labelled as authenticated parents/candidates.

### Atomic writes, immutability and bulk work

- The writer requires an active session transaction. Read the scoped before-state,
  apply the guarded business mutation, read/project its persisted after-state and
  insert the event in that same transaction. Event failure aborts the business
  operation. Standalone MongoDB is not a fallback to unaudited writes.
- A retry re-reads business state and reuses logical mutation IDs. Duplicate IDs
  must not be swallowed to conceal a different mutation. No-op/failed/refused
  business operations append no successful event. Preserve the deletion ledger's
  separate refusal history.
- Do not use generic post-save hooks as the only coverage mechanism: query writes,
  bulk writes, jobs, direct repository calls and cascades must be explicit. Bulk
  operations enumerate changed entities in bounded batches and journal actual
  changes. Preserve documented partial-success semantics and report committed
  counts; never claim atomicity across multiple committed batches.
- Canonical schedule changes and mirror writes share a transaction and one business
  event with related IDs. Independent teacher activities get their own events.
  Provider calls, notifications dispatched externally, file cleanup and AI signals
  occur after commit; their existing durable intents can participate in the transaction.
- New `AuditEvent` rows reject query/document deletion, update, replacement and
  mixed bulk mutation batches. Test direct `save`, update/replace APIs and unordered
  bulk paths; `immutable: true` fields alone are insufficient. Existing ledgers keep
  their existing update semantics, including file-cleanup enrichment.
- Add a unique `mutationId` index and query indexes for campus/time, entity/time,
  partner/time and global/time. Use `(occurredAt, _id)` as a deterministic ordering
  pair. No TTL, soft-delete marker, purge job or danger-zone deletion route. Register
  `RETAIN` on campus/source relations. Database-owner/direct-driver operations are
  outside application-model safeguards, not silently certified as immutable.

### Consultation, export and configuration

Proposed management routes are mounted under `/api/audit` with authentication,
current role checks and existing rate-limiter conventions. Declare named routes
before `/:id`. Keep response helpers and `{ success, message, data, meta }`.

| Route | Behavior |
|---|---|
| `GET /metadata` | Backend-owned enums, filters, limits and coverage metadata; no event data |
| `GET /events` | Scoped list with validated module/entity/action/date filters, page and limit; default limit 50, maximum 100 |
| `GET /events/:id` | Same role, campus and history-window policy as the list; inaccessible IDs return not found |
| `GET /export` | Same filters/authorization; CSV or JSON. Maximum 10,000 events, reject oversized exports instead of silently truncating. Escape CSV cells/formula prefixes; preserve UTF-8 and exposed `Content-Disposition`. |
| `GET /settings` | Effective consultation window for a selected authorized campus; global-history settings only for global roles |
| `PUT /settings` | Change the selected consultation policy and append a `configure` event atomically; no event-retention or deletion control |

Read/export roles default to `ADMIN`, `DIRECTOR`, and `CAMPUS_MANAGER`. The first
two may select campuses or explicitly request global history; a manager remains
within authenticated campus scope through the existing helper. A global event is
not copied into every campus. Other roles receive no general journal endpoint;
existing self-service histories retain their ownership controls. Any future partner
view must enforce campus **and** `partnerId`, never campus alone.

Use an audit-owned `AuditConsultationPolicy` model with `scope`, `schoolCampus`,
`windowDays` and an optimistic `revision`. A unique scope/campus index permits one
policy per campus and one global policy with null campus. Null `windowDays` means
all history and is the default; permit integers 1–36,500. The settings response
exposes `auditConsultation.windowDays` plus revision. Policy creation/changes are
control-plane `configure` events, irrespective of publication eligibility; use
`RETAIN` on campus deletion and no user-facing policy-delete route. Store the global
policy separately rather than assigning global courses to a campus.
`history=recent|archived|all` chooses the read window; default is recent.
At null, recent means all and archived is empty. UTC cutoffs and inclusive/exclusive
date bounds must be explicit in response metadata and tested. Archived history
remains accessible to the same authorized management roles; changing a window
never alters stored events. Detail and export enforce the same requested view.

Lists provide deterministic ordering, not a promise of a multi-request database
snapshot during concurrent writes. A bounded export reads one consistent snapshot;
count and content must agree. Validate primitive types and limits, reject arbitrary
Mongo filters/operators and return stable backend codes: `AUDIT_INVALID_QUERY`,
`AUDIT_INVALID_EVENT`, `AUDIT_SCOPE_REQUIRED`, `AUDIT_TRANSACTION_REQUIRED`,
`AUDIT_IMMUTABLE`, `AUDIT_EXPORT_LIMIT`, `AUDIT_SETTINGS_CONFLICT`. Normal auth and
not-found responses continue to use existing shared helpers.

Audit is core accountability, with no new sold feature key, quota or tier change.
Eligible writes retain their original module entitlement checks. History remains
readable to authorized management when that module is `read_only` or `hidden`;
entitlement never bypasses scope/ownership. Consultation settings require management
authorization, not an entitlement exemption for business writes.

### Consumers, registries and release

The ERP needs a shared journal screen for administrator/director/campus-manager,
an Axios service, filter/settings state, export handling, role navigation and ten
locale catalogues. Reuse existing session transport, campus context, theme handling
and `VITE_API_BASE_URL`. No new AI or applicant-portal journal endpoint is needed.
Exercise existing portal/editorial and admission clients for emitter behavior;
if any underlying request contract changes, update that consumer in the same task.

The build must review all eleven registries: route mounting; audit/owning facades;
core entitlement treatment; hard-delete retention; absence of soft-delete strategy;
existing jobs with new emitters; deterministic fixture counts; translations;
ERP navigation/services; course references; engineering map. The design milestone
changed none of those runtime registries; the storage/writer checkpoint below
records its implementation declarations. New model/index preparation is dry-run first,
expand-only, with explicit release-time application and no legacy-ledger rewrite.
An existing-database report must identify unresolved scope/publication evidence
before anyone claims complete cutover coverage.

### Acceptance and manual cases

Row 8 can close only after all of the following, in the order required by
`CLAUDE.md` §12:

- Model/facade/registry checks; writer rollback, retry, no-op and immutability
  tests, including a disposable real replica set rather than mocks alone.
- Regression checks for every inventoried emitter family, job, alternate route,
  mirror, cascade and detach. Cross-campus and same-campus ownership negatives;
  no credentials or unrelated private content in JSON, CSV, errors or snapshots.
  Explicit business reasons remain the bounded human-text exception.
- Consultation cutoffs, archive reversibility, setting races, export bounds,
  redaction and entitlement states. Consumer/env wiring and all ten locales.
- Feature audit, platform audit, then test audit; reproduce each discovered bug
  before its fix and deliberately invalidate new guarantees to demonstrate red tests.
- Full applicable backend/consumer checks, fixture/journey and course checks when
  affected, followed by browser QA in both themes, global/scoped roles and all
  three originating-module entitlement states. Review actual screenshots.

Planned Workbench identifiers: `ERP-AUD-001` scope/roles/global events;
`002` old/new values and actor provenance; `003` bulk/system and mirror coverage;
`004` consultation windows and reversible archive; `005` export/redaction;
`006` finance/admission/payment consistency; `007` retained history after source
deletion; `008` hidden/read-only modules and navigation. The `ERP-AUD-` prefix
applies to every suffix. These are proposed IDs, **not registered cases**; verify
availability before import through the Workbench UI/API/CLI. Preserve existing
campaign snapshots and executions. Automated transaction-failure evidence belongs
to the test harness; do not require manual users to inject database failures.

No case update is required for this documentation-only milestone: no runtime or
manual workflow has changed. Register concrete executable cases as the UI/API
is implemented, before row-8 acceptance; no manual verdict is claimed here.

## External work retained outside local journal implementation

| Gate and owner | Concrete external action | Evidence required |
|---|---|---|
| CH-0, independent reviewer | Review fixture volumes against QA §4.3 and `seed.config.js`, execute the self-check independently and sign the dashboard | Second-person acceptance; see [CH-0 boundary](ch0-fixture-completion.md#acceptance-boundaries) |
| AI target, infrastructure owner | Provision the target selected in D4, synthetic corpus/actors and private provider configuration; agree test volume/cost, then execute the existing target harness | Real search/chat latency and error reports against the recorded SLOs; [procedure](ai-operational-acceptance.md#remaining-target-acceptance-and-next-action) |
| Existing GED database, release operator | Stop instances that can recreate the legacy TTL; inspect `scripts/retire-document-expiry.js` dry-run on the intended database, apply the specific retirement, verify and start the compatible release | Target index inspection with business rows preserved; [release procedure](ged-expiry-safety.md) |
| Hosted portal CI, repository maintainer | Once a push is authorized, run the existing GitHub workflow and inspect its result | Hosted workflow verdict; local evidence is not a hosted run; [boundary](public-portal-test-foundation.md#evidence-and-remaining-work) |
| WhatsApp, Meta account/release owner | Provision account/sender, obtain template-language approval, configure private credentials and HTTPS signed callbacks, prepare indexes, then send one authorized consented test | Real provider acceptance and receipts; follow the [activation runbook](whatsapp-business.md#real-activation-runbook) and verify current Meta requirements at execution time |

These external gates do not prevent writing/testing the journal locally. They are
not closed by this work, and no live call, release or hosted CI run is reported.
Future journal release needs an operator to inspect and explicitly apply
`node scripts/prepare-audit-journal.js [--apply]` against the intended database.
The command is implemented for indexes only; source eligibility/scope reconciliation
is still unimplemented and must not be presented as runnable or certified coverage.

## Announcement emitter increment — 2026-11-20

The next row-8 increment connects the existing announcement management routes and
expiry job to the internal writer. It does not close row 8. Documents, academic
records, other domains, danger-zone cascades, historical preparation and the ERP
consultation/export/settings surface remain required by the inventory.

The owning service re-reads the campus-scoped announcement and checks workflow
guards inside a transaction. It saves the business state and its explicit
persisted projection with the event in that transaction. Initial publication sets
internal `auditEligible` without an event; persisted publication evidence and the
sticky marker keep subsequent archive, edits, republication, pin changes and soft
deletion eligible. Draft-only changes stay outside the journal. HTTP fields never
set campus, publication evidence or eligibility. User provenance comes from
`req.user`; expiry operations use named system provenance. Retry callbacks retain
one logical mutation handle. Read receipts remain outside mutation coverage.

Title/content changes are redacted; type, lifecycle, dates, pin state and each
target-role membership retain typed values. Identity, timestamps, creation metadata
and the internal eligibility marker are excluded. The schema/projection contract
must classify every model field so a later business-field addition cannot silently
escape review. Existing response envelopes and consumer requests stay compatible;
the originating `announcement` entitlement still guards HTTP writes. Transactions
require a replica set; there is no standalone unaudited fallback.

Expiry/unpin scans use bounded keyset pages and one transaction per row, rechecking
the due predicate before mutation. Counts describe committed rows; a later error
retains the count of earlier commits. A failure never commits the affected row
without its event. The existing nightly job registration remains unchanged.

Manual QA: ERP-AUD-002/003 are the future old/new/system-provenance cases. No
Workbench update is required at this internal increment: there is no consultation
screen/API to execute those cases yet and existing announcement interactions keep
their contract. Register the executable cases before row-8 acceptance. No manual
verdict or retrospective coverage is claimed.

## Storage/writer checkpoint — 2026-11-12

This internal checkpoint implements inventory step 1 without closing row 8.
No production module declares a source or invokes the writer yet. Test-only source
declarations are synthetic and do not make the existing payment workflow audited.

### Implemented contract

- `modules/audit/index.js` exposes `service` and frozen `constants`, with null
  `routes`. Persistence and the model remain internal.
- `service.defineSource` creates an opaque backend-owned declaration with closed
  entity type, operation names and explicit field rules. Owning services will
  freeze their actual projections during emitter integration. Only finite numbers,
  booleans, raw IDs, valid dates and declared enum values are stored as values;
  content fields use change indicators. Unknown projected fields and implicit
  string coercions fail. Absence differs from null; normalized equality is a no-op.
- `createOperation` and `createMutation` allocate opaque server identities outside
  the transaction callback. `appendMutation` compares actual projected states on
  every attempt and requires a real, active session on the journal's Mongo client,
  including for no-ops. Errors and duplicate IDs propagate; no upsert or fallback.
  Source services still own publication eligibility, scope/ownership authorization,
  persisted-state reads/writes and after-commit side effects.
- `AuditEvent` uses timestamps, raw retained source IDs, validated provenance and
  bounded changes/references/reasons. It refuses query/document updates, saves of
  existing rows, replacements, deletion, mixed mutation bulks and `$merge`/`$out`.
  Insert-only bulk validation cannot be disabled by `skipValidation`; lean
  `insertMany` is refused. Existing ledger enrichment remains supported.
- Five schema indexes cover unique mutation identity and ordered campus/entity/
  partner/scope history. `scripts/prepare-audit-journal.js` only reads on dry run,
  including when the namespace is absent. Explicit apply adds missing indexes,
  verifies them and is idempotent; conflicting definitions or any TTL fail before
  mutation. It never drops indexes, rewrites events or reconciles old sources.

The application guards do not constrain direct collection/driver/database-owner
access or another model writing into this collection. Database permissions remain
an operator responsibility; no claim of physical write-once storage is made.

### Eleven-registry review for the foundation

| Registry | Result |
|---|---|
| Route mounting | No HTTP surface; `app.js` unchanged |
| Facades | New internal `audit` facade; contract tests pin all four service methods |
| Features | Core accountability; no new sold key, quota, tier or HTTP exemption |
| Permanent deletion | `AuditEvent` retained by campus and the currently deletable source types Course, Document and Announcement; no journal deletion entry |
| Soft deletion | No marker or strategy override |
| Jobs | No job, purge or new schedule |
| Fixtures | Existing seeded counts/data unchanged; separate synthetic owned-database proof |
| Translations | No new catalogue key or notification/PDF change; existing dynamic danger-zone impact labels are reused |
| Consumers/environment | No endpoint, client or environment-variable change; all later ERP work retained |
| Course | Structural guard required; update measured assertions/prose without rewriting historical snapshots |
| Engineering map | `CLAUDE.md` section 1 documents the internal facade/model/preparation boundary |

No Workbench mutation is required for this internal checkpoint: it changes no
manual workflow. The README was consulted; concrete ERP-AUD-001–008 cases remain
required when consultation and emitter flows exist. No manual verdict is claimed.

### Ordered audits and verification

Feature audit follows the initial four-suite / 387-test pass and real 29/29 proof.
Three findings were reproduced red before correction: two aggregation-write
regressions, two no-op session regressions (spoofed/foreign client), and one
unknown-top-level metadata regression. The fixes add aggregate guards, central
real-session/client verification before projection, and a strict event-key check.

Platform audit verifies the tenant/source `RETAIN` declarations, unchanged legacy
ledger updates, absence of automatic emitters/new entitlements, fixture isolation
and the eleven decisions above. Test audit deliberately disables no-op handling,
redaction, transaction verification, provenance validation, event-shape validation,
query/aggregation guards and index-conflict detection. Six additional variants
exercise the remaining validation boundaries, existing-document saves, deletion
guards, index dry-run/application and TTL rejection: all fourteen variants turn
their targeted regressions red; every original file is restored in `finally`.

A final ownership review also reproduces a missing-partner commission event red
before requiring `partnerId` for that entity type. Unassigned leads still allow
null ownership; authenticated ownership authorization remains the emitter's duty.

The revised owned-database proof passes 32/32, including a real driver automatic
retry after a synthetic transient error, one committed balance/event, rollback on
insertion/validation failure, byte-identical history after each refused mutation,
no partial unordered batch and persisted redaction. Removing the aggregation
guard also makes this real-database proof fail with a missing expected rejection;
the source is restored before the final 32/32 replay. The first sandboxed database
attempt could not open a port (`EPERM`); the owned proof passes with approved local
execution. No test database safety guard was changed.

| Check in this storage/writer checkpoint | Observed result on 2026-11-12 |
|---|---|
| Full Jest with installed Chrome | 102 suites / 1,905 tests pass |
| Owned journal MongoDB journey | 32/32, including automatic driver retry and real negative evidence |
| Fixture self-check | 36/36, including idempotent reseeding and all nine role logins |
| Existing API/data journey | 25/25 on its owned disposable replica set |
| Backend lint | Zero errors / 39 existing warnings |
| Dependency gate | Pass with the same three named exceptions; no dependency change |
| Sequential structural course guard | 67/67 executable solutions, 14 snippets skipped; all cited paths resolve |

The initial course guard passes 58/67; nine solutions contain obsolete counts or
assume a `routes` property always represents an HTTP router. Their measured
assertions and lesson maintenance notes now track 26 module facades (25 HTTP),
63 models, 175 deletion relations including 14 RETAIN, and 102 Jest suites (86
unit, 14 integration, two contracts), 1,365 test call sites and 74 parameterized
declarations. Router discovery checks the actual exported function, preserving
the internal facade's explicit null route. Historical worked examples, output
snapshots and author-review markers remain intact in the separate course repo.

Initial test construction exposed five index-fixture failures from an unwrapped
`test.each` argument; the corrected assertions pass. An early lint attempt on the
evolving test file reported a parse error; the final full lint run passes without
rule changes. These attempts are not counted as accepted verification. Local
proof, mutation and exit-status logs remain ignored under
`tests/fixtures/.generated/audit-journal-2026-11-12/`.

No browser replay or frontend build is claimed for this internal checkpoint:
there is no new HTTP route, consumer or production emitter. Browser/manual
acceptance remains mandatory before full row-8 delivery.

Remaining work: integrate every inventoried source and its actual field rules,
sticky eligibility and transaction boundaries; implement legacy scope/eligibility
reporting, consultation/export/settings and the ten-locale ERP consumer; finish
full feature browser/manual acceptance. This checkpoint does not close those gates.

## Design milestone verification — 2026-11-12

Backend `main` started clean at `95920ac`; the ERP frontend was also clean on
`main`. Read-only inspection covered the inventory's writers/callers and compiled
schema paths for 15 principal models without connecting to a database. Added
documentation references pass checks for 19 local links/anchors and 39 source
paths. `git diff --check` passes; the five edited documents are tracked and the
new inventory is visible as an untracked, non-ignored file pending inclusion in
a later scoped commit. No commit or external write was made in this milestone.

No application suite, build, lint, dependency audit, MongoDB journey, browser or
course run was performed for these documentation-only changes. The prerequisite
results below remain historical evidence for their original code. No new journal
implementation or manual acceptance is certified by this design review.

## Contract for the deletion guard

`protectAuditDeletions(schema)` is a shared schema plugin installed before model
compilation. The model name supplies the error context; no HTTP contract or new
API error code is introduced.

- Refuse `Model.deleteOne`, `deleteMany`, `findOneAndDelete` and its
  `findByIdAndDelete` alias before the database operation.
- Refuse `document.deleteOne` through document middleware as well as query
  middleware.
- Refuse the entire `bulkWrite` batch if any operation contains `deleteOne` or
  `deleteMany`, including unordered and mixed insertion/deletion batches.
- Preserve insertion, reads and existing update semantics, including deletion
  ledger file cleanup enrichment and session propagation.
- Preserve each schema's indexes, collection name and absence of TTL and
  soft-delete markers. There is no data migration or purge.

These are application-level Mongoose safeguards. Direct collection/driver calls
and database-administrator access are outside them. The checks do not claim that
all existing audit records are immutable against arbitrary updates.

## Campus, deletion and entitlement

The existing ledgers use `campusId`; neither gets a new campus field. Their
campus `RETAIN` relations remain unchanged. A consultation window is a read
policy, never a soft-delete marker or a TTL. The eventual shared event schema
must use the actual campus of its business entity; authenticated campus scope
and partner ownership remain mandatory for every reader.

Audit retention is an invariant, not a separately sold feature. Deletion guards
always run, independently of the originating module's entitlement. This
increment changes no tier, feature key or quota.

## Eleven-registry review

| Registry | Decision for this increment |
|---|---|
| 1. `app.js` | No new route or middleware |
| 2. Module facades | No new cross-module import or export; shared plugin only |
| 3. Feature registry | No new entitlement or commercial surface |
| 4. Hard-delete registry | Existing ledger `RETAIN` relations unchanged; no new model |
| 5. Soft-delete helper | Neither ledger gains a deletion marker or override |
| 6. Job registry | No cron or purge |
| 7. Fixture counts | Existing deterministic dataset unchanged; separate disposable proof |
| 8. Translations | No product text, notification or PDF change |
| 9. ERP services/navigation | No changed endpoint or consumer |
| 10. Course inventory | Run the course guard for the shared helper/schema changes |
| 11. Engineering map | Corrected before this note; record the actual protected paths |

## Acceptance for this prerequisite

- [x] Both schemas use the shared guard; query, instance and bulk deletion fail.
- [x] Regression tests demonstrate the original bulk bypasses and pin existing
  query/instance protection. The initial instance regression passed on the
  installed Mongoose 8.24.4; no pre-existing instance bypass is claimed.
- [x] Insertions and legitimate cleanup enrichment still work.
- [x] A disposable real MongoDB replica-set run proves retained bytes and no
  partial insertion in a refused unordered batch.
- [x] Feature, platform and test audits occur in order; regressions have negative
  evidence and findings are closed before acceptance.
- [x] Full Jest, lint, dependency gate and course checks have current evidence.
- [x] Roadmap and handoff retain row 8 as in progress, with the remaining work.

No manual-QA case update is needed for these internal Mongoose safeguards:
HTTP behavior, screens and manual workflows are unchanged. The eventual shared
journal needs cases for scope/roles, transactional event accuracy, consultation
windows, archived history and export before row 8 can close. No case registration
or manual verdict is claimed here.

## Remaining row-8 work

The v1 storage/writer foundation now has an owned-replica-set proof. Connect the
inventoried production emitters with the exact source-field
projections and regression proofs specified above. Retain existing histories and
consumers. Implement consultation/export/settings and the ERP consumer, then finish
the full ordered feature lifecycle and manual-case registration. The design review
and completed deletion guards do not close the commercial claim of a complete
audit log. Unverified historical eligibility and source scope must remain visible
in preparation reports; no historical event may be fabricated to close a count.

## Ordered audits and negative evidence — 2026-11-11

1. Feature audit after the initial 267-check targeted pass and the real MongoDB
   proof: the guard covers both models and rejects the whole batch before
   casting/dispatch. It preserves existing error context and write semantics.
   The initial assumption about an instance bypass was disproved by the actual
   test and removed from the final design; only the bulk bypass is confirmed.
2. Platform audit: existing campus/document `RETAIN` relations, indexes and
   `campusId` paths are unchanged. Deletion-ledger cleanup enrichment remains
   supported. All eleven registry decisions are recorded above; no HTTP contract,
   environment wiring or consumer changes are required for this prerequisite.
3. Test audit: six bulk regressions failed on the original schemas. Removing
   both plugin registrations makes all 16 final unit cases fail. Replacing
   `some` with `every` makes both mixed-batch cases fail; removing `deleteMany`
   detection causes two failures, and removing `deleteOne` detection causes
   four. Disabling the bulk guard makes the real MongoDB journey fail at the
   first bulk operation with a missing expected rejection. Every mutation was
   restored in `finally` before the final validation runs.

No unresolved finding remains within this deletion-guard prerequisite. This does
not certify update immutability or coverage of unimplemented business emitters.

## Dependency-gate correction — 2026-11-11

The first dependency gate fails on four newly reported Mongoose advisories.
The patch updates only Mongoose 8.24.4 to 8.24.7 and mquery 5.0.0 to 5.0.1;
the MongoDB driver and all three named audit exceptions remain unchanged.
The manifest's minimum compatible version follows the corrected 8.x release.

The [upstream 8.24.7 release](https://github.com/Automattic/mongoose/releases/tag/8.24.7)
and advisory references own the fixes:

- [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c):
  respect connection-configured filter sanitization.
- [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96):
  restrict discriminator lookup to registered own properties.
- [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4):
  prevent inherited-property writes during hydration, dotted assignment and merging.
- [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj):
  reject prototype paths in virtual definitions.

Six real-library regressions execute in isolated child processes. All six fail
on 8.24.4 and pass on 8.24.7; positive controls retain ordinary casting, literal
filters and legitimate virtuals/discriminators. The first sanitization probe used
`connection.set`, which takes a different storage path and stayed green; it was
corrected to the native connection's `config` storage before the six-case red run.
The owned MongoDB journey independently reproduces the connection-option failure
on 8.24.4 and passes all 24 checks on 8.24.7, including literal reads and rollback.
Production connection options are not changed by these regression checks.

Targeted validation after the update passes four suites / 273 tests. The dependency
gate passes with the same three exceptions; lint reports zero errors and the same
39 existing warnings. These targeted results do not replace the final full replay.

## Retained unsuccessful validation attempts

- The first full Jest replay passes 99 suites / 1,830 tests but fails the existing
  PDF protocol test's 95-second timeout. The final replay uses the installed
  `/usr/bin/google-chrome`; no assertion or timeout is relaxed.
- The first course guard reports 63/67 executable solutions passing. Its F2
  inventory assertions still expect 99 suites, while cold child-process checks
  also run concurrently with the full backend replay. Exact expectations and
  matching prose are updated to 101 suites; final validation runs sequentially.
- The initial dependency gate's four blocking findings and all failed security
  probes remain evidence of the correction, not accepted exceptions.
- The November 11 final full Jest and fixture attempts were interrupted before
  producing their final verdicts. No validation processes remain at the November
  12 resume; the remaining gates are restarted sequentially with persisted exit
  statuses. Partial logs are not treated as passing checks.

## Prerequisite acceptance — 2026-11-12

The existing-ledger retention prerequisite is complete. Product row 8 remains
in progress with the shared journal work described above.

| Check | Observed result | Date |
|---|---|---|
| Targeted Jest | Four suites / 273 tests pass after the Mongoose update | 2026-11-11 |
| Owned audit-retention MongoDB journey | 24/24; unchanged bytes on refusal, no partial batch, appends, transaction rollback and actual sanitization | 2026-11-11 |
| Full Jest with installed Chrome | 101 suites / 1,837 tests pass; includes actual PDF rendering and all six dependency regressions | 2026-11-12 |
| Fixture self-check | 36/36; byte-identical reseeding and all nine logins | 2026-11-12 |
| Existing API/data journey | 25/25 on its owned disposable replica set | 2026-11-12 |
| Backend lint | Zero errors / 39 existing warnings | 2026-11-11 |
| Dependency gate | Pass with the same three named exceptions; no new exception | 2026-11-12 |
| Course guard | 67/67 executable solutions and reference checks pass sequentially | 2026-11-12 |

Course F2.2/F2.4/F2.5 exact assertions and current prose now follow 101 suites
(85 unit, 14 integration and two contracts), 1,347 call sites and 65 parameterized
declarations. Historical inventory blocks, perturbation results and author-review
markers remain intact. No new lesson or Part B specification change is needed.

No browser replay is claimed for this internal schema prerequisite. Browser and
manual acceptance remain part of the eventual shared-journal delivery. Local
logs are ignored under `tests/fixtures/.generated/audit-retention-2026-11-11/`
and `tests/fixtures/.generated/audit-retention-2026-11-12/`; no generated account
catalogue, credential or screenshot is committed.
