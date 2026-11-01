# Current task and handoff

Last updated: 2026-11-01.
Status: COMPLETED — phase 1-B row 7 WhatsApp Business, source/local acceptance.
Branch: main. Owner requests scoped local commits; no push, deployment or live send.

## Delivered objective and decisions

The [canonical contract and final evidence](architecture/features/whatsapp-business.md)
own implementation, ordered audits, negative regressions and real activation.
D-R11 selects monthly campus/tier quotas 500/2,000/5,000 reserved attempts,
blocking until the next UTC month. Four event families: results, exam grades,
fee reminders and campus fraud alerts. No Meta account/configuration exists;
the owner explicitly accepts local validation plus a real-activation runbook.

Backend: approved localized template transport, settings-owned phone-bound consent,
atomic usage model/repository and campus teardown, signed raw-body callbacks,
canonical legacy targets, scoped replay and submission fencing, all four emitters.
The ERP exposes consent in all nine account menus, removes legacy WhatsApp switches,
and shows delivery state and campus usage in ten locales. No public-portal/AI
contract or environment change is needed. Course inventories/prose are refreshed;
author-review markers remain. The required dependency gate also patches the
transitive follow-redirects lock to 1.16.2 with two observed red/green regressions.

## Observed verification

- Full Jest: 99 suites / 1,815 tests. After the shared-settings mapping extraction:
  four targeted suites / 39 tests, then all 102 facade assertions pass.
- Owned WhatsApp API/data journey: 48/48; existing fixture self-check: 36/36,
  including byte-identical reseeding and all nine logins; base API journey: 25/25.
- Backend lint: zero errors / 39 existing warnings; final harness lint clean.
  Dependency gate passes with the same three named exceptions.
- Actual ERP production build, touched lint and 190 locale combinations pass.
  The unchanged portal is rebuilt for existing admission browser regressions.
- Full browser: 224/224, including 22 WhatsApp checks; both themes, admin and
  campus manager, all originating entitlement states. Six final WhatsApp captures
  are inspected. Focused flags are unset for this complete run.
- Final course guard: 67/67 executable solutions and reference checks pass.
- ERP-WA-001–005 registered via the existing editor/CLI; exact saved/revision
  bodies, preserved 15 prior cases/revisions, idempotent reimport. Fresh read-only
  confirmation finds 20 cases/revisions and no campaigns/executions. No manual verdict.

All 25 audit mutations were detected; the 31 new WhatsApp unit tests were observed
red. Partial-index, legacy receipt/phone, facade-export and redirect corrections
have recorded red/green evidence. Browser closing/entry animation readiness races
are corrected without weakening assertions/deadlines. Interrupted and failed
attempts remain in the canonical note. Local logs/captures are ignored under
`tests/fixtures/.generated/whatsapp-closeout-2026-11-01/`; no generated credentials
or screenshots are staged. Engineering map, roadmap row/§0 and QA dashboard agree.

## Remaining boundary

No implementation work remains within the approved local boundary. Real Meta
account/sender provisioning, approved templates, current Graph version, deployment
indexes/configuration and signed public callback acceptance require a separately
authorized activation following the runbook. This handoff does not authorize it.

CH-0 independent acceptance, deployed AI SLOs, GED release indexes and hosted
portal CI retain their owning gates. No CH-2/CH-4 or phase-2 implementation starts.
