'use strict';

/**
 * @file entitlement.frontend-keys.test.js
 * @description Pins the SPA's feature annotations against the registry
 * (CAMPUS_ENTITLEMENT_DESIGN.md §15, DoD) — the one correspondence the design
 * doc records as pinned by nothing, and whose divergence is silent in BOTH
 * directions:
 *
 *  - a key the SPA uses that the registry does not know is FAIL-OPEN (§4.3):
 *    the entry is drawn unconditionally, so a module sold as optional can never
 *    be switched off, and no error is raised anywhere to say so;
 *  - a registry key no screen annotates is a module with nothing to hide:
 *    switching it off changes nothing the operator can see, and the API starts
 *    answering 403 behind buttons that are still drawn. That is exactly how
 *    `level` and `department` shipped ungated.
 *
 * ── WHY A BACKEND TEST READS THE FRONTEND ───────────────────────────────────
 * The registry is backend-owned (CLAUDE.md §0.1) and the SPA has no test
 * framework of its own, so this is the only side that can hold the invariant.
 * The frontend is a SEPARATE repository (CLAUDE.md, brick 2): when it is not
 * checked out beside this one the suite says so and skips, rather than passing
 * quietly — a cross-brick check that silently succeeds on a missing sibling is
 * worse than none.
 */

const fs = require('fs');
const path = require('path');

const {
  FEATURE_KEYS,
  FEATURE_REGISTRY,
} = require('../../shared/constants/features.constants');

/** Brick 2, as declared in CLAUDE.md — a sibling checkout, never a dependency. */
const FRONTEND_SRC = path.resolve(__dirname, '../../../frontend/src');

/**
 * Registry keys with deliberately no screen annotation, each with the reason
 * it needs none. Anything else missing is a finding, not a convention.
 */
const ANNOTATION_NOT_EXPECTED = Object.freeze({
  account:      'core — never hidden, and it draws no navigable surface',
  campus:       'core — never hidden, and it draws no navigable surface',
  admin:        'core — never hidden, and it draws no navigable surface',
  'danger-zone':'core — governance, surfaced through useHardDelete (§5.2)',
  'public-portal':
    'its ERP-side screens are the editorial admin under src/admin/, and global ' +
    'roles are bound by no entitlement (§5.2). The public site itself is gated ' +
    'server-side in portal-campus.js (§9.2), not by the SPA.',
});

/**
 * Both shapes that carry a registry key. Reading only one under-reports, which
 * is how this check first reported `level` and `department` as unannotated
 * after they had just been gated.
 *
 *   { …, feature: 'result' }        nav tables and route descriptors
 *   <FeatureGate feature="level">   FeatureGate / FeatureGuard / FrozenNotice
 */
const KEY_PATTERN = /feature[:=]\s*(?:'([a-z0-9-]+)'|"([a-z0-9-]+)")/g;

/**
 * Mentioning a key is not gating on it. `FeatureFrozenNotice` ANNOUNCES a
 * frozen module (§6.2) — it withholds nothing, so a key whose only appearance
 * is a notice is a key nothing hides. Counting it would let the gate be
 * deleted while the suite stayed green, which is the exact failure this file
 * exists to prevent.
 */
const ANNOUNCE_ONLY = /FeatureFrozenNotice/;

/** How far back a JSX attribute may sit from its component name. */
const LOOKBEHIND = 3;

/**
 * @param {string} dir
 * @returns {string[]} every .js/.jsx file below `dir`
 */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return /\.jsx?$/.test(entry.name) ? [full] : [];
});

const frontendPresent = fs.existsSync(FRONTEND_SRC);

/**
 * @returns {{ mentioned: Map<string, string[]>, gated: Map<string, string[]> }}
 *   `mentioned` is every appearance; `gated` is the subset that actually
 *   withholds something.
 */
const collectUsage = () => {
  const mentioned = new Map();
  const gated = new Map();

  const add = (map, key, site) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(site);
  };

  for (const file of walk(FRONTEND_SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(KEY_PATTERN)) {
        const key = match[1] || match[2];
        const site = `${path.relative(FRONTEND_SRC, file)}:${index + 1}`;
        add(mentioned, key, site);

        // The component name may sit a line or two above its attribute.
        const context = lines.slice(Math.max(0, index - LOOKBEHIND), index + 1).join('\n');
        if (!ANNOUNCE_ONLY.test(context)) add(gated, key, site);
      }
    });
  }

  return { mentioned, gated };
};

(frontendPresent ? describe : describe.skip)('entitlement — SPA keys vs registry', () => {
  const { mentioned, gated } = frontendPresent
    ? collectUsage()
    : { mentioned: new Map(), gated: new Map() };

  test('every feature key the SPA annotates exists in the registry', () => {
    const known = new Set(FEATURE_KEYS);
    const unknown = [...mentioned.entries()]
      .filter(([key]) => !known.has(key))
      .map(([key, sites]) => `${key} (${sites.join(', ')})`);

    // Fail-open makes this the dangerous direction: an unknown key is not a
    // crash, it is an entry that can never be switched off again.
    expect(unknown).toEqual([]);
  });

  test('every registry key is GATED somewhere, or declared as needing none', () => {
    // `gated`, not `mentioned`: a key whose only appearance is a frozen-module
    // banner is a key nothing hides.
    const ungated = FEATURE_KEYS.filter(
      (key) => !gated.has(key) && !(key in ANNOTATION_NOT_EXPECTED)
    );

    expect(ungated).toEqual([]);
  });

  test('the exemption list itself does not rot', () => {
    // An exemption for a key that no longer exists, or that a screen now
    // annotates after all, is a stale claim about the product.
    const stale = Object.keys(ANNOTATION_NOT_EXPECTED).filter(
      (key) => !FEATURE_REGISTRY[key] || gated.has(key)
    );

    expect(stale).toEqual([]);
  });

  test('the core exemptions really are core', () => {
    const wrong = Object.keys(ANNOTATION_NOT_EXPECTED)
      .filter((key) => /^core —/.test(ANNOTATION_NOT_EXPECTED[key]))
      .filter((key) => !FEATURE_REGISTRY[key].core);

    expect(wrong).toEqual([]);
  });
});

if (!frontendPresent) {
  // Visible in the run output, unlike a silently skipped describe.
  console.warn(
    `⚠️  [entitlement.frontend-keys] frontend brick not found at ${FRONTEND_SRC} — ` +
    'SPA key check skipped. Clone it beside this repo to run it.'
  );
}
