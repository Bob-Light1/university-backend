'use strict';

/**
 * @file scripts/audit-gate.js
 * @description CI gate over `npm audit`: fails on any HIGH or CRITICAL advisory
 *              that is not explicitly accepted below.
 *
 *   `npm audit --audit-level=high` is all-or-nothing: one advisory nobody can act
 *   on forces the whole step to `continue-on-error`, and from then on the audit
 *   gates nothing — a new high lands silently. This gate keeps the step blocking
 *   and moves the exception into a named, reasoned allowlist.
 *
 *   Two ways to fail, both deliberate:
 *     1. an unaccepted high/critical advisory  → fix it, or accept it below;
 *     2. an ACCEPTED entry that no longer appears → delete the entry.
 *   (2) is what stops the allowlist from rotting: an exception outlives its
 *   reason silently, and the next reader takes it for a standing decision.
 *
 *   Advisories are keyed by their ROOT GHSA id, not by package name: one root
 *   advisory surfaces once per package it propagates through (extract-zip →
 *   @puppeteer/browsers → puppeteer-core is one decision, not three).
 *
 * Usage: node scripts/audit-gate.js     (run by .github/workflows/backend.yml)
 */

const { execFileSync } = require('node:child_process');

// ── Accepted advisories ───────────────────────────────────────────────────────

/**
 * Each entry must state WHY the advisory is accepted and WHAT would remove it.
 * Accept only what the deployment provably cannot reach, never what is merely
 * inconvenient to upgrade.
 */
const ACCEPTED = Object.freeze([
  {
    ghsa:   'GHSA-jmr9-qjv8-65gv',
    module: 'extract-zip',
    reason:
      'Unreachable here. extract-zip is called from exactly one place — ' +
      'unpackArchive() in @puppeteer/browsers/install.js, the browser DOWNLOAD path. ' +
      'This backend never downloads a browser: @sparticuz/chromium ships the binary ' +
      'and both PDF services always launch with an explicit executablePath ' +
      '(document.pdf.service.js, academic-pdf.service.js). No `puppeteer browsers ' +
      'install` step exists in the repo, the scripts or the workflows.',
    removeWhen:
      'puppeteer-core ships a CommonJS build again, OR this backend moves to Node >= 22.12 ' +
      'and Jest can load ESM. Upstream fixed the advisory by REMOVAL, in ' +
      '@puppeteer/browsers 3.x — which is ESM-only and requires Node >= 22.12, as is every ' +
      'puppeteer-core built on it. The whole 24.x (CommonJS) line is pinned to the vulnerable ' +
      '2.x, and `require()` of puppeteer-core 25 throws `Cannot use import statement outside ' +
      'a module` on Node 20 and under Jest (measured: 7 suites red). A runtime migration, ' +
      'not a version bump.',
  },
]);

// ── Audit ─────────────────────────────────────────────────────────────────────

const BLOCKING = new Set(['high', 'critical']);
const ghsaOf = (url) => (url || '').split('/').pop();

/** `npm audit --json` exits non-zero when it finds anything — that is not an error here. */
const runAudit = () => {
  try {
    return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
};

/**
 * Walks `via` chains down to the advisory objects that actually carry a GHSA id.
 * String entries are propagation through another package, not a separate finding.
 */
const collectRootAdvisories = (vulnerabilities) => {
  const roots = new Map();

  const walk = (name, seen) => {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = vulnerabilities[name];
    if (!entry) return;
    for (const via of entry.via) {
      if (typeof via === 'string') { walk(via, seen); continue; }
      const ghsa = ghsaOf(via.url);
      if (!roots.has(ghsa)) roots.set(ghsa, { ghsa, title: via.title, module: via.name, severity: via.severity, url: via.url, through: new Set() });
      roots.get(ghsa).through.add(name);
    }
  };

  // Only chains that surface as high/critical somewhere are in scope: npm raises a
  // dependent's severity to that of its worst cause, so entering from the reported
  // packages cannot miss a moderate root that propagates as high.
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (BLOCKING.has(entry.severity)) walk(name, new Set());
  }
  return roots;
};

// ── Report ────────────────────────────────────────────────────────────────────

const main = () => {
  const report = JSON.parse(runAudit());
  const roots  = collectRootAdvisories(report.vulnerabilities || {});
  const accepted = new Map(ACCEPTED.map((a) => [a.ghsa, a]));

  const unaccepted = [...roots.values()].filter((r) => !accepted.has(r.ghsa));
  const stale      = ACCEPTED.filter((a) => !roots.has(a.ghsa));
  const totals     = report.metadata?.vulnerabilities || {};

  console.log(`npm audit: ${totals.critical || 0} critical, ${totals.high || 0} high, ` +
              `${totals.moderate || 0} moderate, ${totals.low || 0} low`);

  for (const a of ACCEPTED) {
    if (stale.includes(a)) continue;
    const r = roots.get(a.ghsa);
    console.log(`\n  ACCEPTED  ${a.ghsa}  ${r.title}`);
    console.log(`            through: ${[...r.through].join(' → ')}`);
    console.log(`            ${a.reason}`);
  }

  for (const r of unaccepted) {
    console.error(`\n  BLOCKING  ${r.ghsa}  [${r.severity}] ${r.title}`);
    console.error(`            module: ${r.module} — reported through: ${[...r.through].join(', ')}`);
    console.error(`            ${r.url}`);
  }

  for (const a of stale) {
    console.error(`\n  STALE     ${a.ghsa} (${a.module}) is no longer reported — delete its entry ` +
                  `from ACCEPTED in scripts/audit-gate.js.`);
  }

  if (unaccepted.length || stale.length) {
    console.error(`\n✖ audit gate: ${unaccepted.length} unaccepted high/critical advisory(ies), ` +
                  `${stale.length} stale exception(s).`);
    process.exit(1);
  }

  console.log(`\n✔ audit gate: no unaccepted high or critical advisory ` +
              `(${ACCEPTED.length} accepted, each with a stated reason).`);
};

main();
