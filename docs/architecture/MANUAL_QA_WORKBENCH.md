# Manual QA Workbench integration

Approved on 2026-10-22: the owner requests a standalone custom manual-QA application,
separate from the four ERP repositories. Its code is located at
`/home/adminsecu/Projects/qa-workbench`.

[The Workbench README](../../../../qa-workbench/README.md) owns navigation and
verified hosting information. Its design defines three phases; its roadmap owns
delivery status and its handoff records actual checks and remaining work. The
initial implementation uses React/TypeScript, Supabase and Cloudflare Pages, with
autonomous accounts and no subscription. Phase 1 is online at
https://qa-workbench.pages.dev; the README and handoff own release/acceptance evidence.

## Product-change workflow

For each product-roadmap task, record the affected manual case IDs and add, revise
or archive the relevant cases before closing the task. If no manual-QA impact exists,
record the reason in the owning task/design note. Editing cases does not rewrite
existing campaign snapshots or historical executions. Use the documented Workbench
UI, API or agent CLI, with project-scoped credentials.

Initial pilot: ten short cases cover login/logout, campus visibility, receipt
download, finance read-only behavior, public program/form validation and IA-service
unavailability. The target is the existing local synthetic ERP environment. The
online QA support does not deploy the ERP or make localhost reachable remotely.
No secrets, generated passwords, real student data or invitation links belong in cases.

## Existing boundaries

This is external QA support, not a new ERP product phase or runtime module. It does
not close CH-0 independent acceptance, implement CH-2/CH-4, alter commercial plans,
complete admission row 5 or change the established product phase order.

The existing online-admission design and unanswered OA choices remain with their
owning work item. The current task takes priority without authorizing new admission
implementation. Application checks are run in the Workbench repository; ERP-only
documentation changes require link, accuracy, whitespace and Git visibility checks.
