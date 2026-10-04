# Current task and handoff

Last updated: 2026-10-04.
Status: IMPLEMENTATION COMPLETED — phase 1-B row 1 / CH-0 independent acceptance pending.
Backend branch: `main`; starting commit: `7f172ef`.

## Objective and authorization

The owner asked to continue the roadmap using the authoritative document.
[ERP_ROADMAP.md](architecture/ERP_ROADMAP.md) keeps phase 1-B in progress;
this pass resumes row 1, the deterministic fixture, without advancing phase 2.
[The CH-0 note](architecture/features/ch0-fixture-completion.md) owns scope,
registry review, audits and acceptance evidence. QA §12.3 / D-14 requires a
second person's acceptance; implementation self-checks cannot close CH-0.

The previous AP-01–AP-09 handoff was historical: its changes are merged into
`main`. [Its correction note](architecture/features/admin-portal-audit-corrections.md)
retains the administrator-acceptance and external-integration boundaries.

## Implementation

Eight added fixture collections, two records each on A and one on B: GAET,
notifications, preferences, print jobs, transcripts and GED versions/shares/templates.
The fixture now builds 307 documents across 39 seeded collections, plus Counter.
References and ownership are verified; all dates and nested IDs are deterministic.
No production API, schema, deletion policy or entitlement change.

Only the owned disposable MongoDB server disables TTL monitoring. Caller-owned
servers with TTL enabled are refused before purge; production and URI checks also
apply to the programmatic seed. CI gains a fixture self-check job using the existing
replica-set helper. D-06 remains open for CH-2, as required by QA §4.11.

The dependency gate found GHSA-c475-qrg2-pj4r in existing basic-ftp 5.3.1.
A get-uri-scoped override installs 6.2.1; no other locked package changes.
Real loopback FTP listing/download compatibility passes; the audit gate passes
with the same two named extract-zip exceptions.

## Validation

- Complete backend Jest: 78 suites / 1,620 tests PASS (2026-10-02).
- Disposable fixture self-check: 36/36 PASS; first seed 5.9 s (2026-10-02).
  Nine new Jest cases were observed red before implementation, then green.
- Lint: zero errors, 40 existing warnings. Dependency audit gate PASS with its
  same two existing exceptions (2026-10-02).
- API journey: 21/21 PASS on the expanded fixture (2026-10-02).
- Fresh frontend build: PASS in 3 m 16 s (2026-10-04). Output moved to
  `/tmp/roadmap-ch0-frontend-dist-2026-10-04`; loopback API wiring.
- Full course: 67/67 executable solutions PASS, 14 illustrative snippets skipped;
  references PASS (2026-10-04). Initial count/location failures were reproduced
  and corrected. No assertion or deadline was relaxed.
- Complete browser: 114/114 PASS, exit 0 (2026-10-04), using local Chrome for
  the PDF engine. Receipt checks pass. The estate check now waits for campus
  data rather than a fixed sleep; its loading-screen failure was observed before
  correction. Captures inspected in both themes for student/campus manager and
  for the populated administrator estate. Lint rerun: zero errors, 40 warnings.

Private logs are retained in ignored `tests/fixtures/.generated/ch0/evidence/`.
Captures are in adjacent `visual*` directories. The old temporary files were
removed between sessions; archived proof remains. Do not publish credentials.

## Preserved changes and remaining work

The user's one-character edit in `docs/context.md` is preserved. The separate course
repository already had edits in lessons/solutions F2.2, F2.4 and F2.5; they are
preserved. This task synchronizes F2.1 and obsolete measurements in 18.1/F2.2/F2.4/F2.5,
plus indices and changelog (course 2.17.5). Prior edits are retained. Updated
lessons are marked for author review; the generated reference map is unchanged.
No course or backend commit has been made.

Implementation, local validation and dashboard updates are complete. Next action:
a second person reviews QA §4.3 against `seed.config.js`, runs the self-check and
signs acceptance under §12.3 / D-14. CH-0 remains `EN COURS` until then.
Remote GitHub Actions was not run. Full administrator acceptance, external
AI/image/delivery gaps and CH-2/4/5 remain under their original work items.
