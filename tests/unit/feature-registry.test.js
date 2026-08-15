'use strict';

/**
 * shared/constants/features.constants.js — the per-campus entitlement registry
 * (docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md, phase 0).
 *
 * Like tests/unit/soft-delete.test.js and tests/unit/hard-delete.test.js, this suite runs
 * against the REAL registry, the REAL `app.js` and the REAL models on purpose. It does not
 * test a helper in isolation — it PINS the guarantees the entitlement system depends on:
 *
 *   - every mounted router is governed by a declared feature, so a module can never ship
 *     ungated and silently ignore a campus that disabled it;
 *   - every HARD edge matches a `required` foreign key that actually exists, so a toggle
 *     refusal can never be raised (or skipped) on a relation nobody has;
 *   - the HARD graph stays acyclic among non-core modules, so no pair of modules can end up
 *     blocking each other into being permanently undisableable;
 *   - no module depends on a higher commercial tier than its own, which would make it
 *     unreachable on the plan that includes it;
 *   - every declared cron exists in `server.js`, and every cron in `server.js` is declared
 *     with its nature — the emission/hygiene split is what keeps a disabled module from
 *     emailing users while still honouring legal retention.
 *
 * A registry that drifts from the code fails here rather than in production.
 */

const fs   = require('fs');
const path = require('path');

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  PLAN_RANK,
  CRON_NATURE,
  MAX_UNTIL_MONTHS,
  FEATURE_REGISTRY,
  UNGATED_MOUNTS,
  FEATURE_KEYS,
  CORE_FEATURE_KEYS,
  FLOORED_FEATURE_KEYS,
  FEATURE_REQUIRED_BY,
  FEATURE_DEGRADES,
  PLAN_PRESETS,
  FEATURE_CRONS,
} = require('../../shared/constants/features.constants');

const ROOT        = path.join(__dirname, '..', '..');
const MODULES_DIR = path.join(ROOT, 'modules');

// ─── Fixtures read from disk (never from a mocked registry) ───────────────────

/** Recursively collects files matching a predicate. */
const walk = (dir, match, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, acc);
    else if (match(entry.name)) acc.push(full);
  }
  return acc;
};

const MODEL_FILES = walk(MODULES_DIR, (name) => name.endsWith('.model.js'));
const APP_SOURCE  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
// Cron registration moved out of server.js into shared/lib/register-jobs.js (B9-①):
// server.js wrapped fifteen independent operations in one try, so one broken module
// left ZERO jobs registered. The registrations — and therefore this invariant — now
// live in `projectJobs()`.
const { projectJobs } = require('../../shared/lib/register-jobs');

/** The module a file belongs to: `modules/<key>/...`. */
const moduleOfFile = (file) => path.relative(MODULES_DIR, file).split(path.sep)[0];

/**
 * Mongoose model name → owning module key. Only DECLARATIONS count
 * (`mongoose.model('X', schema)`); a bare `mongoose.model('X')` is a lazy
 * lookup of a model owned elsewhere and must not claim ownership.
 */
const MODEL_OWNER = MODEL_FILES.reduce((acc, file) => {
  const source = fs.readFileSync(file, 'utf8');
  for (const [, name] of source.matchAll(/mongoose\.model\(\s*["'](\w+)["']\s*,/g)) {
    acc[name] = moduleOfFile(file);
  }
  return acc;
}, {});

/**
 * `required` foreign keys per module, as { module: Set<referencedModel> }.
 * Matches both orders (`ref` before `required` and the reverse) and both quote
 * styles — a single-quote-only pattern silently missed a third of the schemas
 * during phase 0.
 */
const REQUIRED_REFS = MODEL_FILES.reduce((acc, file) => {
  const source = fs.readFileSync(file, 'utf8');
  const key    = moduleOfFile(file);
  acc[key] = acc[key] || new Set();
  const patterns = [
    /ref:\s*["'](\w+)["'][^}]{0,150}?required:\s*(?:true|\[\s*true)/gs,
    /required:\s*(?:true|\[\s*true)[^}]{0,150}?ref:\s*["'](\w+)["']/gs,
  ];
  for (const pattern of patterns) {
    for (const [, model] of source.matchAll(pattern)) acc[key].add(model);
  }
  return acc;
}, {});

/**
 * Routers mounted in `app.js`, as { moduleKey: [mountPath] }. Resolves the
 * variable used in `app.use(path, variable)` back to the module it was required
 * from, so a module whose route prefix differs from its directory name
 * (`modules/exam` → `/api/examination`) is still matched correctly.
 */
const MOUNTED = (() => {
  // A governed surface whose source directory does not carry the registry key.
  // `shared/lib/hard-delete` mounts /api/danger-zone: it is a platform-level
  // gate, not a module, so its key is named after the surface it exposes.
  const SOURCE_ALIASES = { 'hard-delete': 'danger-zone' };

  const map = {};
  for (const match of APP_SOURCE.matchAll(
    /const\s+(\w+)\s*=\s*require\(['"]\.\/(?:modules\/([\w-]+)|shared\/lib\/([\w-]+))['"]\)/g
  )) {
    const source = match[2] || match[3];
    map[match[1]] = SOURCE_ALIASES[source] || source;
  }

  const mounts = {};
  for (const [, mountPath, variable] of APP_SOURCE.matchAll(
    /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g
  )) {
    const key = map[variable];
    if (!key) continue;                       // plain middleware, not a module router
    mounts[key] = mounts[key] || [];
    mounts[key].push(mountPath);
  }
  return mounts;
})();

// ─── 1. Structural integrity ──────────────────────────────────────────────────

describe('registry structure', () => {
  test('every entry declares the full contract', () => {
    for (const key of FEATURE_KEYS) {
      const entry = FEATURE_REGISTRY[key];
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.core).toBe('boolean');
      expect(Array.isArray(entry.dependsOn)).toBe(true);
      expect(Array.isArray(entry.usesWhenAvailable)).toBe(true);
      expect(Array.isArray(entry.records)).toBe(true);
      expect(Array.isArray(entry.crons)).toBe(true);
      expect(entry.routers.length).toBeGreaterThan(0);
      expect(Object.values(PLAN_RANK)).toContain(PLAN_RANK[entry.minPlan]);
    }
  });

  test('every edge points at a declared key, and no edge is both hard and soft', () => {
    for (const key of FEATURE_KEYS) {
      const { dependsOn, usesWhenAvailable } = FEATURE_REGISTRY[key];
      for (const target of [...dependsOn, ...usesWhenAvailable]) {
        expect(FEATURE_KEYS).toContain(target);
      }
      // A relation is structural or it is enrichment — never both, or the
      // refusal rule and the impact preview would disagree about it.
      for (const target of dependsOn) expect(usesWhenAvailable).not.toContain(target);
      expect(dependsOn).not.toContain(key);
      expect(usesWhenAvailable).not.toContain(key);
    }
  });

  test('the registry and its derived views are frozen', () => {
    expect(Object.isFrozen(FEATURE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(PLAN_PRESETS)).toBe(true);
    expect(Object.isFrozen(FEATURE_REQUIRED_BY)).toBe(true);
    expect(Object.isFrozen(FEATURE_DEGRADES)).toBe(true);
  });

  test('a router is declared exactly once across the whole registry', () => {
    const owner = new Map();
    for (const key of FEATURE_KEYS) {
      for (const route of FEATURE_REGISTRY[key].routers) {
        expect(owner.has(route)).toBe(false);
        owner.set(route, key);
      }
    }
  });

  test('MAX_UNTIL_MONTHS bounds a time-boxed override (decision D-F)', () => {
    expect(MAX_UNTIL_MONTHS).toBe(12);
  });
});

// ─── 2. Core and floor semantics ──────────────────────────────────────────────

describe('core and floor', () => {
  test('core entries are reachable on every plan and carry no floor', () => {
    for (const key of CORE_FEATURE_KEYS) {
      const entry = FEATURE_REGISTRY[key];
      // A core module gated behind a paid tier could never be enabled on free,
      // which contradicts "always enabled, for anyone".
      expect(entry.minPlan).toBe(FEATURE_PLANS.FREE);
      // `core` already means "always enabled"; a floor on top would be dead
      // configuration that a reader would take for an effective constraint.
      expect(entry.minState).toBeNull();
      expect(entry.records).toEqual([]);
    }
  });

  test('the validated core set is exactly the one that was signed off', () => {
    expect([...CORE_FEATURE_KEYS].sort()).toEqual([
      'account', 'admin', 'campus', 'class', 'danger-zone',
      'notification', 'settings', 'student', 'teacher',
    ]);
  });

  test('a floor is declared with the records it protects, and only there', () => {
    for (const key of FEATURE_KEYS) {
      const { minState, records } = FEATURE_REGISTRY[key];
      if (minState === null) {
        expect(records).toEqual([]);
      } else {
        expect(minState).toBe(FEATURE_STATES.READ_ONLY);
        expect(records.length).toBeGreaterThan(0);
      }
    }
    expect([...FLOORED_FEATURE_KEYS].sort()).toEqual(['document', 'exam', 'finance', 'result']);
  });

  test('every protected record is a model that actually exists', () => {
    for (const key of FLOORED_FEATURE_KEYS) {
      for (const model of FEATURE_REGISTRY[key].records) {
        // A record name with no model behind it makes the emptiness probe match
        // nothing: the floor would never engage and the module would be hideable
        // while holding institutional archives.
        expect(MODEL_OWNER[model]).toBeDefined();
        expect(MODEL_OWNER[model]).toBe(key);
      }
    }
  });
});

// ─── 3. The HARD graph against the real schemas ───────────────────────────────

describe('hard dependency graph', () => {
  test('every hard edge matches a required foreign key in the module schemas', () => {
    for (const key of FEATURE_KEYS) {
      const refs = REQUIRED_REFS[key];
      if (!refs || refs.size === 0) {
        // No required ref at all: the module cannot legitimately declare a
        // structural dependency on anything.
        expect(FEATURE_REGISTRY[key].dependsOn).toEqual([]);
        continue;
      }
      const owners = new Set([...refs].map((model) => MODEL_OWNER[model]).filter(Boolean));
      for (const target of FEATURE_REGISTRY[key].dependsOn) {
        expect([...owners]).toContain(target);
      }
    }
  });

  test('every cross-module required foreign key is declared as a hard edge', () => {
    for (const key of FEATURE_KEYS) {
      const refs = REQUIRED_REFS[key] || new Set();
      for (const model of refs) {
        const owner = MODEL_OWNER[model];
        if (!owner || owner === key) continue;          // own model, or an actor model
        // An undeclared structural reference is a toggle that orphans rows
        // without ever refusing: the exact failure mode the 409 exists for.
        expect(FEATURE_REGISTRY[key].dependsOn).toContain(owner);
      }
    }
  });

  test('the hard graph is acyclic among non-core modules', () => {
    // A cycle between two disableable modules makes BOTH permanently
    // undisableable: each one refuses on account of the other.
    const nonCore = FEATURE_KEYS.filter((key) => !FEATURE_REGISTRY[key].core);
    const found = [];
    const visit = (start, node, seen) => {
      for (const next of FEATURE_REGISTRY[node].dependsOn) {
        if (FEATURE_REGISTRY[next].core) continue;      // core can never be disabled
        if (next === start) { found.push(`${start} -> ${node} -> ${next}`); continue; }
        if (seen.has(next)) continue;
        seen.add(next);
        visit(start, next, seen);
      }
    };
    for (const key of nonCore) visit(key, key, new Set([key]));
    expect(found).toEqual([]);
  });

  test('requiredBy and degrades are the exact reverse of the declared edges', () => {
    for (const key of FEATURE_KEYS) {
      for (const target of FEATURE_REGISTRY[key].dependsOn) {
        expect(FEATURE_REQUIRED_BY[target]).toContain(key);
      }
      for (const target of FEATURE_REGISTRY[key].usesWhenAvailable) {
        expect(FEATURE_DEGRADES[target]).toContain(key);
      }
    }
  });
});

// ─── 4. Commercial tiers ──────────────────────────────────────────────────────

describe('plans', () => {
  test('no module structurally depends on a higher tier than its own', () => {
    for (const key of FEATURE_KEYS) {
      for (const target of FEATURE_REGISTRY[key].dependsOn) {
        // Otherwise the module is included in a plan on which it cannot work:
        // its rows need an entity the campus is not entitled to create.
        expect(PLAN_RANK[FEATURE_REGISTRY[target].minPlan])
          .toBeLessThanOrEqual(PLAN_RANK[FEATURE_REGISTRY[key].minPlan]);
      }
    }
  });

  test('presets are cumulative and always contain the whole core', () => {
    expect(PLAN_PRESETS[FEATURE_PLANS.FREE].length)
      .toBeLessThan(PLAN_PRESETS[FEATURE_PLANS.STANDARD].length);
    expect(PLAN_PRESETS[FEATURE_PLANS.STANDARD].length)
      .toBeLessThan(PLAN_PRESETS[FEATURE_PLANS.PREMIUM].length);
    for (const plan of [FEATURE_PLANS.FREE, FEATURE_PLANS.STANDARD, FEATURE_PLANS.PREMIUM]) {
      for (const key of CORE_FEATURE_KEYS) expect(PLAN_PRESETS[plan]).toContain(key);
    }
    for (const key of PLAN_PRESETS[FEATURE_PLANS.FREE]) {
      expect(PLAN_PRESETS[FEATURE_PLANS.STANDARD]).toContain(key);
    }
    for (const key of PLAN_PRESETS[FEATURE_PLANS.STANDARD]) {
      expect(PLAN_PRESETS[FEATURE_PLANS.PREMIUM]).toContain(key);
    }
  });

  test('premium includes everything', () => {
    expect([...PLAN_PRESETS[FEATURE_PLANS.PREMIUM]].sort()).toEqual([...FEATURE_KEYS].sort());
  });

  test('CUSTOM grants nothing implicitly', () => {
    expect(PLAN_PRESETS[FEATURE_PLANS.CUSTOM]).toBeUndefined();
  });
});

// ─── 5. Coverage: app.js ↔ registry ───────────────────────────────────────────

describe('router coverage', () => {
  test('every module router mounted in app.js is governed by a registry entry', () => {
    for (const key of Object.keys(MOUNTED)) {
      // An ungated module answers a campus that disabled it as if nothing had
      // been decided — the silent failure the whole system exists to prevent.
      expect(FEATURE_KEYS).toContain(key);
    }
  });

  test('every registry entry is actually mounted', () => {
    for (const key of FEATURE_KEYS) {
      expect(Object.keys(MOUNTED)).toContain(key);
    }
  });

  test('an explicit mount path is declared by its own entry', () => {
    for (const [key, paths] of Object.entries(MOUNTED)) {
      if (!FEATURE_REGISTRY[key]) continue;
      for (const mountPath of paths) {
        // A module may also expose a deliberately ungated surface — `ai` mounts
        // /internal/ai for service-to-service reads, which carries no user JWT
        // and is never published by the reverse proxy.
        if (UNGATED_MOUNTS.includes(mountPath)) continue;
        // A multi-route module mounts at the bare '/api' prefix and declares its
        // real sub-paths; anything more specific must match a declared router.
        if (mountPath === '/api' || mountPath === '/api/') {
          for (const route of FEATURE_REGISTRY[key].routers) {
            expect(route.startsWith('/api/')).toBe(true);
          }
          continue;
        }
        expect(FEATURE_REGISTRY[key].routers).toContain(mountPath);
      }
    }
  });

  test('ungated mounts are an explicit allowlist, never a fallback', () => {
    expect(UNGATED_MOUNTS).toEqual(
      expect.arrayContaining(['/internal/ai', '/api/ping', '/api/health', '/health'])
    );
    for (const mountPath of UNGATED_MOUNTS) {
      for (const key of FEATURE_KEYS) {
        expect(FEATURE_REGISTRY[key].routers).not.toContain(mountPath);
      }
    }
  });
});

// ─── 6. Crons: emission vs hygiene ────────────────────────────────────────────

describe('crons', () => {
  test('every declared cron carries a known nature and a valid owner', () => {
    for (const cron of FEATURE_CRONS) {
      expect(Object.values(CRON_NATURE)).toContain(cron.nature);
      expect(FEATURE_KEYS).toContain(cron.feature);
      expect(typeof cron.name).toBe('string');
    }
  });

  test('the registry declares exactly the jobs the platform schedules', () => {
    // Names, not just a count: a matching total with a drifted name is the case
    // a count would pass. A job scheduled but undeclared keeps running for a
    // disabled module; a job declared but unscheduled makes the
    // emission/hygiene split a fiction.
    expect(FEATURE_CRONS.map((cron) => cron.name).sort())
      .toEqual(projectJobs().map((job) => job.name).sort());
    // And server.js must not grow a second, ungoverned registration site.
    expect(SERVER_SOURCE).not.toMatch(/cron\.schedule\(/);
  });

  test('hygiene jobs are the ones that must survive a disabled module', () => {
    const hygiene = FEATURE_CRONS
      .filter((cron) => cron.nature === CRON_NATURE.HYGIENE)
      .map((cron) => cron.feature)
      .sort();
    // Retention answers a legal duty; the print sweep drains in-flight jobs;
    // announcement expiry and competition closing settle state nobody sees.
    expect(hygiene).toEqual([
      'academic-print', 'announcement', 'document', 'notification', 'public-portal',
    ]);
  });

  test('emission jobs are the ones a disabled module must silence', () => {
    const emission = FEATURE_CRONS
      .filter((cron) => cron.nature === CRON_NATURE.EMISSION)
      .map((cron) => cron.feature)
      .sort();
    expect(emission).toEqual(['exam', 'finance']);
  });
});
