# Current task and handoff

Last updated: 2026-09-19.
Status: COMPLETED — sibling context documentation and reference corrections.
Branch observed: `feat/fee-receipts-and-reminders`.

## Objective and completed work

The user requested compact session context for the ERP frontend, AI service and
public pre-registration portal, consistent with their existing engineering references.
Created `AGENTS.md`, `docs/context.md` and `docs/current_task.md` in each repository.
Updated this backend's context map with links to their startup protocols.

Read local CLAUDE/README files, portal contract/deployment documentation, relevant
AI design sections, code/configuration and Git state. A user-approved follow-up corrected the references themselves: AI README status
and prompt inventory, portal README/API/deployment guides and backend paths,
and frontend namespace/SSE rules and historical lint/CI claims. Context maps
now remove resolved drift notices. Fourteen sibling documentation files were updated.
The AI protocol preserves the README's full-design reading requirement before code.
No application code, dependency, product decision or deployment was changed.

## Verification

Checked the nine new context documents and subsequent corrections for local link
targets, whitespace, Git visibility and documentation diffs. Existing unrelated
working-tree changes were preserved. Application tests/builds were
not run for this documentation-only task. New files remain uncommitted.
Sibling writes required and received filesystem escalation because only the backend
and temporary directory were initially writable.

## Preserved work and unresolved release gates

The previous product-home/branding implementation is complete; its owning
[design and release gates](architecture/features/product-home-and-branding.md#remaining-release-gates)
retain the delivery evidence. Historical backend/browser/course/build results are
not checks from this session. Existing backend dependency-audit failures and ERP
lint errors still prevent claiming full release readiness; this task did not
retest or remediate them. No CH-* work item was closed or phase reordered.

The backend was clean at this task's start. Frontend and portal had existing
uncommitted branding changes, including frontend entitlement/dashboard work;
all were preserved. AI was clean. The course remains a separate nested repository.
The former handoff mentioned a frontend dev server on port 5173; its current state
was not checked. No commit or deployment was made.

## Next action

Use the local startup protocol for the next user-requested task, verify the branch
and working tree, and read its required detailed references. This completed task
does not authorize dependency remediation or other historical follow-ups.
