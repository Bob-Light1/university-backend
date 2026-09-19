# Product home and deployment branding

Status: implementation complete; release validation blocked by existing dependency and frontend lint debt.
Approved by the owner on 2026-09-18. Verification updated on 2026-09-19.

## Problem and scope

Replace the ERP's immigration-oriented landing page with a professional product
showcase for academic institutions. Keep recruitment, campus discovery, quizzes,
referrals and applications in the existing public portal. The ERP home contains
only a secondary link to that portal. No pricing, unsupported claims, testimonials,
live customer data, lead collection or business workflow changes.

| Brick | Change |
| --- | --- |
| Backend | Deployment brand for spreadsheet metadata and winner notifications |
| ERP frontend | Product home, local interactive preview, ten locales, public shell and shared branding |
| Public portal | Compatible brand configuration, logos and metadata; preserve establishment identity and intake |
| AI service | Reviewed: no commercial brand in user-facing output; no code change needed |

## Approved design

Light institutional presentation, navy typography, restrained orange actions.
One footer. Hero, six capability groups, three-tab synthetic preview, role benefits,
product FAQ and closing action. Public content remains light independently of the
authenticated theme. Keyboard navigation, RTL and reduced motion are required.

The preview is illustrative, entirely local and explicitly labelled; it must not
fetch business data or imply that the preview is a publicly accessible real account.
Public locale selection persists locally without unauthenticated settings requests.

## Contract and compatibility

No new API, schema, migration or authentication contract. Brand configuration is
per deployment, not per campus. Product defaults to Wewigo. Existing establishment
names/logos and configured portal identity take precedence in institutional content.
Name/logo/icon are configured in each brick's environment; no cross-repository imports.
Sender identity is configured separately and never inferred from a product name.

Commercial action: validated HTTPS URL first, then email; otherwise link to the
local product preview. Optional legal destinations are displayed only when valid.
Keep `/login`, `/allcampus`, `/contact` and `/register` compatible; preserve referral
parameters in the existing registration redirect. No public admin credentials.

## Campus scope, deletion and entitlement

No business queries, persistence or deletion added. Existing campus and ownership
rules remain authoritative. No new entitlement key: public product descriptions
are marketing content, not permissions; availability depends on the campus offer.

## Registry review

| Registry | Outcome |
| --- | --- |
| app.js | No new API route |
| Module facades | No new cross-module export |
| Feature constants | No entitlement change |
| Hard-delete registry | No entity change |
| Soft-delete strategies | No entity change |
| Job registry | Existing competition job reads brand helper; no new job |
| Fixture counts | Synthetic database volumes unchanged |
| Translation catalogs | New home catalog in all ten ERP locales; portal text uses existing translated labels |
| Services/navigation | Public navigation updated, no new business service |
| Course hooks | Check structural references for new shared frontend components |
| Engineering map | Document brand configuration and the public home |

## Verification and definition of done

Follow CLAUDE.md §12: design, build, regression checks, code/platform/test audits,
repository checks, then browser QA. Test default/custom brand, missing logo,
commercial URL/email/no destination, locale persistence, all preview tabs,
360/390/768/1440 px, RTL, keyboard and reduced motion. Verify authenticated screens
in both themes and existing three-state entitlement QA with synthetic data.
Backend tests/lint/audit, frontend build/touched-file lint/catalog check, portal
build/lint, course structural check and test:visual are required. Existing failures
and environmental blockers must be reported separately. No CH-* work item is closed
by these feature-specific checks. Preserve unrelated working-tree changes.

## Delivery evidence

Application changes are implemented across B1/B2/B4. B3 was inspected and needs no
commercial identity change. No deployed environment, dependency version or lockfile
was changed. No CH-* item or other roadmap phase is closed by this work.

| Check | Actual result |
| --- | --- |
| ERP production build | Passed on 2026-09-18; existing bundle-size warning |
| Portal production build / lint | Passed on 2026-09-18; 117 generated pages |
| ERP translations | All 190 locale/namespace combinations passed |
| Backend full Jest run | 73 suites / 1571 tests passed on 2026-09-19 |
| Backend lint | Zero errors; 42 existing warnings |
| New ERP components lint | Passed; nine existing errors in touched legacy files reproduced against HEAD |
| Course references and solutions | All references resolve; 67 executable solutions passed, 14 illustrative snippets skipped |
| Browser QA | 90/90 passed with local Chrome, including 32 public-home checks and existing authenticated journeys |
| Custom deployment | Atlas Education home, initial HTML metadata, login, activation, missing-logo fallback and configured sales URL passed |
| Portal identity precedence | Wewigo default, custom product and establishment override passed against the real resolver |
| Negative controls | All five new unit tests failed with deliberately broken compiled inputs, then passed against unchanged real sources |
| Dependency audit | Blocked: seven unaccepted advisories in unchanged dependencies |

Browser checks cover ten home locales, 360/390/768/1440 px in English/French/Arabic,
keyboard tabs/menu, reduced-motion preference, light public content with saved dark
theme, local locale persistence and zero business/settings requests. Screenshots
were visually inspected for the homepage and campus/student workspaces. Existing
QA verifies enabled/read-only/hidden entitlement states, both themes, multiple
roles, actual PDF downloads and scoped exports. The first browser run failed PDF
startup with the packaged Chromium binary; rerunning with the supported
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome` passed all 90 checks. The QA
process and its cached PDF browser were stopped after their final report.

Evidence is retained locally under `tests/fixtures/.generated/product-home-validation/`
(logs) and `tests/fixtures/.generated/visual/` (screenshots); these are ignored
artifacts, not production or customer data. Historical/interrupted runs are not
counted as final successes.

### Remaining release gates

`npm run audit:ci` reports 0 critical, 6 high and 5 moderate dependency findings,
with seven unaccepted advisories: extract-zip `GHSA-7pqw-9j4j-h8q3`, js-yaml
`GHSA-2883-xcg3-v3hh`, nodemailer `GHSA-8m3c-c648-2xjj`, `GHSA-wmmp-3585-3rmp`,
`GHSA-2x7j-588g-ccc2`, `GHSA-cc9r-2j5m-2m83`, and sharp `GHSA-rgj7-g3m4-5g8c`.
The existing exception is not broadened. This feature did not introduce these
packages, and a successful UI review does not waive the dependency gate.

The nine existing ERP lint errors occur in AdminDashboard, the older admin Navbar,
AppNavBar, LoginPage, DirectorDashboard and main.jsx. Their baseline comparison
prevents attributing them to this change, but they remain release debt. These two
gates prevent declaring the entire CLAUDE.md definition of done satisfied.

## Deployment configuration

| Meaning | ERP frontend | Backend | Public portal |
| --- | --- | --- | --- |
| Product name | `VITE_BRAND_NAME` | `PRODUCT_BRAND_NAME` | `NEXT_PUBLIC_PRODUCT_BRAND_NAME` |
| Product logo | `VITE_BRAND_LOGO_URL` | Not rendered by the changed exports | `NEXT_PUBLIC_PRODUCT_BRAND_LOGO_URL` |
| Product icon | `VITE_BRAND_ICON_URL` | Not applicable | `NEXT_PUBLIC_PRODUCT_BRAND_ICON_URL` |
| Establishment override | Existing campus records | `BRAND_NAME`, then legacy `NEXT_PUBLIC_BRAND_NAME` | Existing `NEXT_PUBLIC_BRAND_NAME` |
| Establishment assets | Existing campus records | Existing campus records | `NEXT_PUBLIC_BRAND_LOGO_URL`, `NEXT_PUBLIC_BRAND_ICON_URL` |

The backend sample is [product-brand.env.example](../examples/product-brand.env.example);
the ERP and portal samples are in their respective `.env.example` files.
Keep product values aligned across deployments. Public variables contain no secrets.
Vite and Next.js values are built into the client: rebuild both after a change;
restart the backend for server configuration changes. Blank product name means
Wewigo. Portal establishment overrides and campus API names/logos are preserved.
Existing institutional notification sender `RESEND_FROM_EMAIL` remains separate;
without it, winner email delivery is skipped rather than inventing a domain.

`VITE_SALES_URL` accepts HTTPS (loopback HTTP for development), then
`VITE_SALES_EMAIL` is used if valid. Without either, actions point to `#preview`.
`VITE_PRIVACY_URL` and `VITE_TERMS_URL` are optional real HTTPS destinations.
`VITE_PORTAL_URL` still owns applicant routing; production deployments must set it.
No deployed values or secrets were changed during implementation.

## Audit findings and regression evidence

- Configurable brand HTML initially rendered angle brackets as markup in winner
  notifications. `product-brand-notification.test.js` reproduced the failure before
  escaping through the existing `shared/utils/html.js` helper. Sender configuration
  is tested separately; no external notification is sent by these checks.
- Public locale persistence previously attempted a settings PATCH without an
  authenticated user. The shared hook now gates the server write on identity; the
  browser regression asserts zero business/settings requests from the home.

### Review conclusions

The code review checked the approved note against capability descriptions, URL
validation, configuration precedence, metadata escaping and neutral logo fallback.
The platform review checked shared locale persistence, authenticated branding,
existing notification sender configuration, real Excel metadata, unchanged campus
identity and the unchanged `/register?ref=...&src=...` redirect/portal attribution.
No API, schema, persistence, deletion or entitlement declaration changed.

The original test review executed the actual frontend resolver in a VM and reopened
a real Excel workbook; it did not duplicate their implementation in an expectation.
On 2026-09-19, the backend unit suite stopped loading the sibling frontend resolver
so it can run from a backend-only checkout. It tests the backend brand configuration
and real workbook metadata directly. Frontend URL validation is no longer covered
by this backend unit suite.
Negative controls replaced product-name resolution, bypassed URL validation,
removed the sender guard and removed brand HTML escaping in compiled test inputs.
All five tests rejected those faults. The course classifier was corrected after
it incorrectly treated VM execution as a static source-text assertion (51/51
checks after the fix). The final course run also verifies the updated source counts.
