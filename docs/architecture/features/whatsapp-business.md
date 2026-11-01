# WhatsApp Business — phase 1-B row 7

Date: 2026-11-01. Status: source/local acceptance complete; real Meta activation pending.

## Problem and approved scope

Finish the existing notification channel with approved Meta templates, explicit
self-service consent, campus monthly limits and authenticated delivery callbacks.
The owner selects D-R11 monthly campus/tier quotas: free 500, standard 2,000,
premium 5,000, blocking further submissions until the next UTC calendar month.
The four event families are results, exam grades, fee reminders (including
pre-due cadence), and campus fraud alerts. No account or templates exist at Meta;
the owner requests complete local acceptance and a real-activation runbook.
No live send, deployment, price change, later roadmap phase or account provisioning.

## Bricks touched

| Brick | Scope |
|---|---|
| Backend | Notification orchestration, templates, callbacks, quota persistence; existing settings consent storage and four emitters |
| ERP frontend | Shared consent dialog reachable by all nine roles; delivery log statuses and campus quota; ten locales |
| Public portal / AI service | No API or environment changes; neither consumes these authenticated surfaces |

## Contract

Backend frozen constants own supported templates, parameter order, locales,
provider states, skip codes and limits. Only configured, explicitly approved
(template, locale) pairs can send. No free-text or English fallback for WhatsApp.
The deployment supplies a validated JSON map of approved names and language codes;
a generated submission catalogue contains exact text and positional parameters.
Provider requests use template payloads, a bounded timeout and sanitized errors.

`GET /api/notifications/my/whatsapp-consent` and
`PUT /api/notifications/my/whatsapp-consent` expose the caller's own consent.
PUT accepts `{ enabled: boolean, phone?: E.164 string, version?: string }`. Enabling requires an
explicit international phone and the current consent version; disabling retains
revocation evidence. Legacy actor `notificationPrefs.whatsapp` is never consent.
All actual sends re-read consent; it must match recipient model, campus and phone.
Consent has no automatic expiry; changing the recipient phone requires new consent.
The UI explains the four event families and immediate withdrawal.

`GET /api/notifications/whatsapp-usage` is management-only and campus-scoped;
global actors must explicitly select a campus. Planless/custom/unknown campuses
have zero allowance until an administrator assigns a supported plan. This channel
fails closed on unavailable entitlement/consent/quota data, independently of the
existing module-display fail-open policy. Other delivery channels remain available.

Quotas count reserved submission attempts, including provider failures/timeouts:
no ambiguous request is refunded. The atomic monthly counter cannot overshoot
under concurrent workers. A started WhatsApp submission is never automatically or
manually resubmitted: neither provider timeouts nor process death prove absence of
delivery. A skipped preflight can be replayed after fixing consent/config/quota.
Accepted submissions retain `status: sent` (provider acceptance); separate
`whatsapp.deliveryStatus` records sent/delivered/read/failed/unknown. Read receipts
never mark an in-app notification as read. Duplicate/out-of-order callbacks cannot
regress delivery state. Callback authentication uses the exact raw HTTP body,
HMAC-SHA256, constant-time comparison and configured phone-number identity.
GET verification returns Meta's challenge only for the deployment verify token.
Callback updates are limited to known message/recipient/sender identities.

## Campus scope and deletion

Notification and WhatsAppUsage use `schoolCampus`; UserPreferences keeps its
existing `campusId`. Consent lookup keys on trusted recipient identity, not body
campus. Log replay reads and claims both carry the authenticated campus filter.
WhatsAppUsage has unique `(schoolCampus, month)` and no business TTL or archive
marker. It is an operational campus sidecar, removed only through campus danger-zone
cascade. Consent shares existing actor/campus UserPreferences teardown.

## Entitlement

Inherit core `notification`; no new sellable module. Emissions obey the originating
result/exam/finance/partner feature in all three states, including retries.
WhatsApp quotas are a separate frozen tier policy and do not settle D-R10 capacities.
Notification declares its required campus model dependency and optional settings access through their facades.

## Eleven-registry review

1. app.js: preserve exact raw body only for the public webhook; existing notification mount.
2. Notification/settings facades: explicit consent, usage and callback services.
3. features.constants.js: frozen WhatsApp monthly tier policy; required campus and optional settings dependencies.
4. Hard-delete registry: WhatsAppUsage campus cascade; existing consent sidecar retained.
5. Soft-delete overrides: nothing; new usage collection has no archive concept.
6. Jobs: nothing; UTC monthly buckets need no reset cron; existing retry worker retained.
7. Frozen fixture counts: nothing; owned journey creates additional ephemeral rows after seeding.
8. Catalogues: existing ten-locale message bodies reused; ERP consent/status/quota translations.
9. ERP services/navigation: existing Axios client and global account menu; inherited core key.
10. Course: run the structural guard; no file moves or new lesson authorized.
11. CLAUDE map: update notification contract, HTTP surface and unchanged cron semantics.

## Acceptance checklist

- [x] Contract, rollout/index preparation and submission catalogue documented.
- [x] Models, repositories, services, routes and every consumer wired.
- [x] Consent, quota races, signatures, replay isolation, failures and callback ordering covered.
- [x] Feature audit, platform audit and test audit recorded in order, with red/green evidence.
- [x] Full Jest, lint, dependency gate, real disposable journey and course guard pass.
- [x] ERP build/locales/touched lint; complete browser replay and inspected screenshots.
- [x] Two themes, global/scoped roles, all originating entitlement states covered.
- [x] ERP-WA-001–005 manual cases registered without fabricated execution verdicts.
- [x] Engineering map, roadmap, QA dashboard and handoffs updated; scoped local commits.

## Official protocol references and activation boundary

Use Meta's [Cloud API template documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates),
[webhook examples](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)
and [webhook verification reference](https://developers.facebook.com/docs/graph-api/webhooks/getting-started).
Direct retrieval on 2026-11-01 returned HTTP 429/unavailable; Meta's
[archived SDK verification reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/)
confirms signature verification. Recheck current API version and account/template
readiness during real activation. Local contract checks cannot establish Meta approval,
provider delivery, charges or deployed callback reachability.

## Real-activation runbook

1. Provision the owner's Meta business account, sender phone and least-privilege
   system-user access separately. Verify the currently supported Graph version and
   sender/WABA ownership against the current Meta console and documentation.
   Nothing in this task provisions or certifies those external resources.
2. Generate `node scripts/prepare-whatsapp.js --catalog`. Submit the exact bodies,
   languages, suggested names and ordered positional parameters in Meta. Approval
   is per language; configure only pairs actually approved. Utility classification
   is a submission proposal and must be accepted by Meta. There is no generic,
   free-text or translated fallback. Do not translate `{dueDate}` a second time:
   existing finance emitters format it in the recipient's language.
3. Provision the server-only values in
   [the environment example](../examples/whatsapp.env.example). Configure a long,
   independently generated verify token and Meta app secret privately. Example
   mapping shape (publish only after genuine approval):
   `{"result.published":{"fr":{"name":"erp_result_published","language":"fr","approved":true}}}`.
   No provider credentials belong in the ERP build or Workbench cases.
4. Inspect `node scripts/prepare-whatsapp.js` first. During an explicitly authorized
   release, run `node scripts/prepare-whatsapp.js --apply` against the intended
   database; this creates collections/indexes only, never rewrites business rows.
   Do not use syncIndexes or remove indexes. The installed complete unique
   `(schoolCampus, month)` index is checked before cost reservation; an absent or
   partial index disables submissions. No historical consent is backfilled.
5. Deploy the backend and matching ERP build with the existing VITE_API_BASE_URL
   wiring. Configure Meta's HTTPS callback URL as
   `/api/notifications/whatsapp/webhook`, complete GET verification and subscribe
   the sender/WABA app to the messages field. Check that the reverse proxy preserves
   exact request bytes and the signature header. Keep provider credentials absent
   until the account, approval, indexes and callback setup are all ready.
6. Use only an owner-approved test recipient with explicit current consent and a
   matching profile phone. Trigger one allowed business event. Verify a template
   submission, one reserved slot, provider message id, signed delivered/read receipts
   and no cross-campus visibility. Confirm withdrawal stops subsequent sends.
   Record this as later real-provider acceptance, not as evidence from local tests.
7. Roll back activation by clearing the server WhatsApp token/configuration and
   restarting the deployment. Keep consent, usage and notification history; do not
   refund uncertain attempts or retry started submissions. Preflight-skipped rows
   may be explicitly replayed after readiness is restored. Cost limits count every
   reserved submission, including rejection/timeouts; unused slots do not roll over.
   UTC month boundaries reset allowance through a new bucket, without a reset job.

No live Meta approval, provider SLO, delivery, price or webhook reachability is
claimed by source/local acceptance. External activation is the owner-approved
remaining operational step and does not authorize deployment by this agent.


## Ordered audits and negative evidence — 2026-11-01

Feature tests preceded three distinct reviews. The owned real-data journey first
exposed Meta handshake keys being rewritten by the global Mongo sanitizer; the
GET verification handler now reads dotted protocol names from the original URL.
The same exact-challenge check passed after that correction. The first journey
also corrected a test assumption: the canonical campus helper ignores a scoped
actor's requested campus rather than returning 403; the assertion now requires
the response to retain campus A. This does not weaken isolation.

1. Feature audit: a partial unique index could falsely satisfy the quota readiness
   check while leaving other campuses unprotected. A dedicated test was red before
   rejecting partial/sparse/TTL indexes and green afterward. Reservations require
   the complete unique campus/month key before the atomic conditional increment.
2. Platform audit: legacy notifications do not acquire new nested defaults through
   lean updates. The missing receipt-rank initialization test was red before
   initializing unknown/rank-zero at the first submission fence and green afterward.
   The real journey also submits an actual legacy-shaped stored row. Scoped replay
   now constrains both the read and atomic claim; the journey refuses foreign-campus
   managers and same-campus partners without submitting.
3. Test audit: 25 deliberate, individually restored source mutations cover consent,
   consent input, campus, all tier values, template approval/catalogue/payload,
   provider error privacy, HMAC, callback validation/binding, preflight, submission
   fence, originating entitlement, first-delivery claim, replay scope, uncertain
   replay, atomic quota/index/duplicate races and receipt ordering/legacy metadata.
   All 25 were detected and all 31 new unit tests were observed red. One receipt
   assertion initially stayed green: Jest interpreted a dotted update key as a
   nested path. Direct indexed-key inspection corrected that oracle; the same
   ordering mutation then failed as intended. No mutation remains in source.

A final contract negative check also removes the notification facade's WhatsApp
export temporarily. The new contract assertion fails at getConsent; the exact
original source is restored before the green replay of all 102 facade assertions.

The dependency gate separately reported GHSA-mrwp-f3q8-3g9p. Two real loopback
cross-realm credential regressions failed against follow-redirects 1.16.1 and passed
against the compatible 1.16.2 patch. Only that lock entry changes, with no added
exception. [Upstream advisory](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p).

## Registration evidence — 2026-11-01

The existing CLI registered ERP-WA-001–005 using the existing active ERP editor
membership and publishable configuration. All five saved bodies and authored
revision bodies exactly match tests/manual/whatsapp.cases.json. Before/after checks
preserved all 15 existing cases and 15 revisions; campaign and execution counts
remained zero. A second import was idempotent. No service credential, membership
change, campaign snapshot or manual execution verdict is involved.

## Acceptance replay — 2026-11-01

Source/local acceptance is complete. The final complete browser replay passes
**224/224**, including all 202 existing checks and 22 WhatsApp checks, with both
focused flags explicitly unset. All six final consent/log captures are inspected:
administrator and campus manager, light/dark themes, readable scope, withdrawal,
phone and quota; originating modules cover enabled/read_only/hidden. The final
captures wait for entry animations and have no transient dialog transparency.

| Check | Observed result |
|---|---|
| Full Jest | 99 suites / 1,815 tests pass |
| Later shared-settings constant extraction | Four targeted suites / 39 tests, then all 102 facade assertions pass |
| Owned WhatsApp API/data journey | 48/48 pass, including real quota concurrency and legacy callbacks |
| Existing fixture self-check and base journey | 36/36 and 25/25 pass; byte-identical reseeding and all nine role logins |
| Backend lint | Zero errors / 39 existing warnings; final changed-harness lint clean |
| Dependency gate | Passes with the three existing named exceptions; no new exception |
| ERP consumer | Actual production build, touched-file lint and 190 locale/namespace combinations pass |
| Candidate portal regression prerequisite | Unchanged source rebuild passes with explicit loopback API wiring |
| Course | Final sequential guard: 67/67 executable solutions and reference check pass |
| Catalogue/preparation | All 70 exact pairs; default preparation is read-only |
| Manual QA | ERP-WA-001–005 registered; exact bodies, prior cases/revisions preserved, identical reimport unchanged |

Preference-storage role discriminators are shared by settings and consent.
The original Director discriminator is preserved; authentication's Admin model
mapping must not replace this separate storage contract. The full Jest run
precedes that extraction; the subsequent targeted/facade runs verify it.
The fixture/base regressions invoke their existing main functions from a temporary
working directory with random fixture JWT keys and external integrations disabled.
Database guards and deadlines remain unchanged.

Task logs and captures are retained locally in ignored
`tests/fixtures/.generated/whatsapp-closeout-2026-11-01/`. They are reproducible
acceptance artifacts, not committed credentials or manual campaign verdicts.
Git whitespace, document links, manual source paths and tracking checks are part
of closeout. No public-portal/AI consumer contract or environment change is needed.
No new lesson is authorized; exact course inventories and affected prose are
maintained with author-review markers intact.

### Retained negative evidence

- The pre-resume browser pass was interrupted; partial screenshots never counted
  as acceptance, and temporary /tmp logs did not survive continuation. A redundant
  post-resume launch failed on the original test harness's occupied ports.
- The first complete post-resume pass reached candidate admission, then correctly
  refused a missing portal `.next/BUILD_ID`. The unchanged portal rebuild passes
  before the final replay. An initial Mongo startup exceeded its unchanged
  60-second timeout during concurrent cold build work; the sequential WhatsApp
  journey passes 48/48 afterward.
- An initial course replay passed 65/67: exact route inventory and a cold
  10-second child-process boot failed. Correct inventory/prose maintenance and
  sequential replay produce 67/67. No timeout or assertion is weakened.
- One targeted command named a nonexistent settings test; the corrected four-suite
  command passes. The first diagnostic flag was cleared by the provider-environment
  scrubber; its capture now precedes scrubbing. That accidental partial shared run
  was stopped and never counted as acceptance.
- A rebuilt full replay passes the 202 existing checks, then reports four WhatsApp
  reopen failures (210/214 reached). It clicked before MUI removed the closing
  backdrop. Waiting for dialog removal fixes this: focused replay passes 22/22.
  Visual inspection then catches entry-animation captures; waiting for full
  opacity and finished animations yields the inspected final 224/224 replay.
- The legacy-target regression requires canonical phone persistence at the first
  submission fence. It fails before the correction and passes afterward; the
  real-data journey submits a stored legacy row without a plus and advances its
  signed delivered callback. No historical row is proactively rewritten.

Real Meta account readiness, template approval, current Graph version, deployed
callback reachability, delivery and provider charges remain external activation
checks under the approved runbook. No live send, release or CH-* acceptance is
claimed. There is no remaining implementation work within the owner's local
acceptance boundary.
