# Current task and handoff

Last updated: 2026-10-22.
Status: COMPLETED — external manual-QA Workbench phase 1; admission design retained below.
Backend: main; documentation changes reviewed against 5d3a2af for local commits.
The earlier admission investigation started with clean backend, ERP and portal trees.

## Current priority — external manual QA

The owner approved implementation of the standalone Workbench at
`/home/adminsecu/Projects/qa-workbench`, with three-phase design/documentation and
a first online release. [Integration protocol](architecture/MANUAL_QA_WORKBENCH.md)
owns the ERP-side rule: every product task updates affected manual case IDs or
records why no update is needed. All four AGENTS/context documents now link to it.
The Workbench's own handoff owns application implementation and acceptance evidence.
Phase 1 is available at https://qa-workbench.pages.dev, release 891d37a. Hosted
two-account workflows, 11 API denial/access checks and a hosted-export restoration
into an empty local installation passed. The Workbench handoff owns detailed evidence.
No phase-2 work is started.

Preserve the unrelated admission draft and the pending choices below. No ERP
application/consumer/fixture code is changed by this documentation integration.

## Retained admission objective and approved decisions

The owner requests the logical next phase 1-B work and invites questions where
their intervention is needed. Row 13 is locally delivered; continue with row 5.
[Online admission](architecture/features/online-admission.md) owns the design,
verified starting behavior, registry review and acceptance plan.

D-R24 remains approved: only DIRECTOR/ADMIN pronounces admission, campus manager
prepares the dossier, and no automatic payment prerequisite in this version.
No push, deployment, historical automatic conversion or phase 2 work.

## Current work

- Read the backend context/handoff, roadmap and applicable engineering workflow;
  inspected actual lead routes/repository/models, ERP callers, portal queue,
  student requirements, activation, private storage and notification contracts.
- Created the row-5 design draft and corrected its roadmap brick coverage to
  B1/B2/B4: the existing ERP lead drawer must follow the new contract.
- Identified the current authorization/consistency gaps and planned atomic
  student/status/commission creation, explicit activation/delivery handling,
  file accounting and private applicant access if selected.
- Submitted OA-1–OA-3 to the owner: candidate/private-link versus manager-only
  uploads; configurable/common/manual dossier requirements; management versus
  director/admin-only enrollment finalization. Recommendations are unapproved.
- No application, consumer, migration, fixture or test code changed. Row 5 stays
  `À FAIRE` until implementation starts, per CLAUDE.md §12.1.

## Validation

Commit preparation on 2026-10-22: 43 local Markdown targets/anchors pass, including
both new roadmap references. Workbench release claims match its README and handoff;
all four repositories contain the AGENTS/context references. Whitespace and Git
visibility checks pass. Changes are grouped into admission-design and Workbench
integration commits. These documentation changes require no manual-case update.
Application suites and browser QA have not been rerun; historical row-13 results are recorded in
[the foundation evidence](architecture/features/public-portal-test-foundation.md).

## Remaining work and next action

Wait for OA-1–OA-3 answers, record them in the design, freeze the conditional
contract and implement through the full CLAUDE.md §12 workflow. Do not infer
approval from silence. The design records all eleven registry obligations and
the tests/audits/browser acceptance still required before delivery.

The actual ERP and portal directories are outside writable roots. Prepare any
consumer changes in a writable copy, then use scoped write approval for final
synchronization if required. No sibling edits or approval attempts have run.

## Retained external acceptance

Existing-database GED installed-index rollout remains required on release;
[GED expiry safety](architecture/features/ged-expiry-safety.md). AI target SLOs
still require unavailable infrastructure; independent CH-0 and administrator
acceptance remain with their owning notes. Row 13's first hosted CI run awaits
an authorized push. No production DDL or deployment ran. Preserve phase order,
commercial decisions and CH-* acceptance boundaries.
