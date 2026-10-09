# Authentication session hardening — phase 1-B row 3

Started: 2026-10-05. Updated: 2026-10-09. Status: delivered — phase 1-B row 3.

## Problem and scope

Before this change, all nine roles received seven-day bearer tokens. Logout only cleared the
browser, and the SPA called a nonexistent refresh endpoint. Deliver short access
tokens, rotating refresh credentials, server revocation and temporary account
lockout. Existing activation, role/campus/partner ownership and IP rate limits
remain mandatory. Deployment and live-database changes are outside this task.

| Brick | Change |
|---|---|
| Backend | Account session repository/service, shared authentication, eight login controllers (nine roles), refresh/logout routes |
| ERP frontend | Axios refresh, bootstrap, logout and SSE authentication |
| Public portal / AI service | Inspect consumers; no direct ERP login expected |

## Contract

Backend constants own issuer, errors and durations: access 15 minutes; refresh
session absolute lifetime seven days; five failed password checks lock an account
for 15 minutes. Lock state is keyed by model and account id, so email/username
aliases and IP changes cannot bypass it. Existing generic credential errors do
not disclose account existence or lock state.

Login preserves `data.token` and `data.user`. A random refresh secret travels only
in an HttpOnly cookie; only its SHA-256 digest is stored. Production cookies are
Secure and SameSite=None for the existing cross-site deployment; local HTTP uses
SameSite=Lax. Cookie path is `/api/account/session`. Refresh/logout require a
custom request header and the expected session id, preventing cross-origin form
CSRF and accidental identity switching between tabs. CORS keeps its origin allowlist.

POST `/api/account/session/refresh` rotates the secret atomically and returns
`data.token`. Reuse of a spent secret revokes the session family. POST
`/api/account/session/logout` revokes the current session and clears its cookie.
POST `/api/account/session/logout-all` revokes all sessions of the authenticated
account. GET `/api/account/session` verifies the current session. POST
`/api/account/session/revoke` revokes the bearer-authenticated session when its
cookie is unavailable or belongs to another identity.

Access tokens carry a session id. Both mandatory and optional authentication check
the database. Password/status/campus/role/permission changes invalidate sessions;
deleted accounts cannot refresh or keep using access tokens. Session validation
fails closed on database errors. Legacy tokens lacking a session id require a new
login when this release is deployed; there is no insecure compatibility window.

The SPA serializes login/refresh/logout with Web Locks across supported tabs,
coalesces refresh within a tab, retries only expired access tokens once,
and never treats a wrong password as an expired session. A session mismatch or
failed refresh clears identity and authorization defaults. Reload refreshes an
expired token before restoring authentication. Logout waits for server revocation.

## Scope, deletion and entitlement

Session and lock records are operational authentication data, keyed by userModel /
userId with nullable schoolCampus derived from the stored account. They have no
soft-delete convention. Expiry TTL applies only to these ephemeral credentials,
never to business records. Actor and campus danger-zone cascades include them.
Authentication is always available and receives no commercial entitlement key.

## Eleven registries

| Registry | Finding / change |
|---|---|
| App mount | Existing `/api/account` mount; five named session routes before `/:model/:id/resend`. Public cookie routes precede mandatory authentication. |
| Account facade | Export `sessions` and frozen `sessionConstants`; shared middleware and eight login controllers use the facade lazily. |
| Feature constants | No new commercial surface/key. Authentication remains mandatory independently of entitlement. |
| Hard-delete registry | Both operational models in the lazy accessor table; actor and campus cascades, scoped to model/account or authoritative campus. Protected business relations unchanged. |
| Soft-delete overrides | None: operational sessions/locks have no business deletion marker. Six legitimate ephemeral TTL indexes now documented; the separate GED TTL defect remains open. |
| Jobs | No cron added; existing eight jobs unchanged. Expiry is checked synchronously independently of MongoDB TTL cleanup. |
| Fixture counts | Same 307 documents / 39 seeded collections. Auth rows are created at runtime, not frozen into the business seed. The new disposable authentication journey is in CI after fixture self-check. |
| Localization catalogs | No new visible translation keys; existing ten locales and 190 combinations pass. Browser actions use the built locale catalog. |
| Frontend services/navigation | Cookie session transport, Axios bootstrap/retry/logout and SSE; remaining backend calls use shared transport. External Cloudinary upload remains external. No new navigation entry. |
| Course map | Regenerated reference map, exact census assertions and updated JWT teaching; course 2.17.7, affected anchors marked for author review. |
| Engineering map | Account facade/routes/session policy, scope inventory, TTL exceptions, dependency pins and existing cron map updated. |

## Definition of done

- [x] Contract, account/campus/ownership scope and deletion conventions verified.
- [x] All consumers and environment wiring complete; ten locales preserved.
- [x] Eleven registries reviewed with explicit changes/no-change findings.
- [x] Unit and HTTP regressions, every new assertion exercised red; disposable
      database checks prove rotation races, revocation, lockout and all nine roles.
- [x] Feature, platform and test audits; findings closed with red/green evidence.
- [x] Full Jest, lint, dependency gate, affected journey/fixture checks, course
      structural checks, frontend build and localization pass.
- [x] Browser QA: two roles including campus scope, two themes, three entitlement
      states, refresh/reload/logout and screenshots inspected.
- [x] Engineering map, roadmap and handoffs reflect actual results.

## Audits and regression evidence

Tests preceded audits: the initial 25 service checks passed before the feature
re-read. The following findings were then reproduced with red regressions and
closed; later mutation replay verified the guards again.

| Audit | Finding and resolution | Red / green evidence |
|---|---|---|
| Feature | Login could preserve an administrator role or staff permissions read before issuance. Re-read the actor and derive authorization from the fingerprint snapshot. | Role and permission regressions fail with the old issuance behavior; final 38 targeted tests pass. |
| Feature | An invented secret could revoke another session; replay history was incomplete/unbounded. Revoke only known spent credentials and cap history at 1,000 atomic rotations. | Invented/spent credential mutants each fail their regression; actual concurrent rotation is verified on MongoDB. |
| Platform | An old API failure could clear a newer login or retry its mutation under that identity. Bind response handling to the session in the token actually sent, including an identity change while awaiting the request interceptor. | Two client tests red before correction; eight client transport tests green. |
| Platform | Partner password reset logged its credential and email in production. Remove credential logging, preserving its existing delivery stub and development response. | Production privacy regression red before removal; 30 backend session tests green. |
| Platform | Three newly disclosed dependency advisories block the mandatory gate. Apply Sharp 0.35.5, proxy-addr 2.0.8 and source-map-js 1.2.2; preserve the two existing named extract-zip exceptions. | Real gate red on three advisories, then green; actual proxy trust and production image resize/storage checks pass. |
| Tests | Comparing token lifetime only against the imported constant misses a changed policy. Pin agreed durations/thresholds independently and assert the actual session deadline. | The policy mutant initially stayed green, then fails after the independent assertions. |
| Tests | Browser harness treated a transparent main background as black and skipped the manager role picker. Read the rendered body color and select the actual role. | First browser replay 138/141; corrected full replay passes 146/146, with 12/12 authentication checks again on the final build. These were harness defects, not UI regressions. |

Mutation replay uses temporary Jest source transformers, retaining the working
tree. All 37 original targeted cases were observed red, plus the subsequently
added privacy case (38/38). Cookie protection, role/campus/actor changes, lockout,
rotation/replay, CSRF, logout ownership, unavailable persistence and browser
identity races are each perturbed. The final unmodified targeted suites pass.

### Current checks (2026-10-09)

- Full Jest: 82 suites / 1,673 tests pass. Fixture CI wiring replay: 25/25.
- Authentication journey: 78/78 on an owned disposable replica set; all nine
  roles, atomic competing refresh, concurrent failed passwords across aliases/IPs,
  expiry without TTL, credential/archive invalidation, logout/all devices,
  administrator bootstrap and actor/campus cascade selectors.
- Fixture self-check: 36/36; existing real-database journey: 25/25.
- Backend lint: zero errors, 40 existing warnings. Touched frontend lint: zero
  errors/warnings; localization: 190/190 combinations. Final loopback build passes.
- Dependency gate passes with two existing exceptions, no new exception. Real
  Sharp storage resizes a synthetic 4000×100 PNG to 3000×75; malformed proxy trust
  cannot trust an unrelated address, and normal loopback trust still works.
- Course: 67/67 executable solutions pass; 14 illustrative snippets skipped;
  reference map is current. F2.3 passed 83/83 in isolation after a transient
  full-run failure; the subsequent complete replay also passed.
- Browser: 146/146 complete checks, including enabled/read_only/hidden offers and
  both themes. After the final request-metadata refinement, targeted transport
  tests pass 8/8 and authentication browser checks pass 12/12 on the rebuilt SPA.
  Administrator/manager light and dark screenshots, parent dark, the read-only
  banner and hidden mentor refusal were inspected. Artifacts: ignored
  `tests/fixtures/.generated/row3/visual` and `/tmp/row3-auth-current`.

Full-run logs for this execution are under `/tmp/row3-checks`; these are temporary
artifacts, while the counts and audit resolutions above are the lasting record.
Local conventional commits coordinate backend, frontend and course; no publication
or live-database operation was performed.

### Release and limits

Deployment is not performed. Prepare the two new operational collections/indexes
with `node scripts/prepare-auth-sessions.js --apply` before enabling the release;
without `--apply` it reports the expand-only plan without a database connection.
The real-database journey applies it twice and verifies the unique lock index.
No account rewrite or conversion of old tokens is needed. Old access tokens
require a fresh login after the release. Configure `JWT_SECRET`, the existing
`FRONTEND_URL` CORS allowlist and `VITE_API_BASE_URL` together; production cookies
require HTTPS and browser acceptance of the configured cross-site cookie.

Web Locks provide cross-tab serialization where supported. The fallback still
coalesces requests in one tab; concurrent refresh in unsupported multi-tab
browsers fails closed and can require sign-in. Logout retains local identity if
both server revocation transports fail, avoiding a false success while server
credentials remain usable. Partner reset delivery remains the pre-existing
provider-selection work item; this task removes its logging leak only. Public
portal and AI service consumers were inspected: neither uses ERP login sessions;
existing API-key/S2S contracts remain unchanged. CH-0 independent acceptance and
earlier administrator acceptance remain with their owning work items; these
regressions do not deliver CH-2, CH-4 or CH-6.

Dependency sources: [Sharp maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w),
[proxy-addr release](https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8),
[source-map-js release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2).
