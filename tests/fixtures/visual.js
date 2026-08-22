'use strict';

/**
 * @file visual.js
 * @description The browser half of the entitlement QA — what only a rendered
 * page can answer: which entries a campus actually DRAWS
 * (`docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §15, DoD).
 *
 *   npm run test:visual
 *
 * Like `journey.js`, one process end to end: ephemeral replica set, the
 * deterministic fixture, the real `app.js`, the BUILT SPA served statically,
 * and headless Chrome. Nothing can reach a real database — `seed.config.js`
 * refuses anything but a loopback host named like a test database.
 *
 * ── WHY THIS EXISTS ON TOP OF THE STATIC CHECK ──────────────────────────────
 * `tests/unit/entitlement.frontend-keys.test.js` proves every registry key is
 * gated SOMEWHERE. It cannot prove that every surface listing a module gates
 * it: `course` was gated in `CampusRoutes.jsx` and in the drawer, and still had
 * an ungated card on the campus dashboard's "Campus Modules" grid — a live
 * entry point, on the manager's landing page, opening a route that then
 * answered "not activated". Only a rendered page shows that.
 *
 * ── PREREQUISITES, AND WHY IT IS NOT IN `npm test` ──────────────────────────
 *   · a mongod binary (as `seed:test:self-check` and `test:journey` need);
 *   · Chrome at /usr/bin/google-chrome (driven through `puppeteer-core`);
 *   · a CURRENT `frontend/dist` — it serves the build, not the dev server, so
 *     run `npm run build` in the frontend brick after changing it, or this
 *     checks the previous build.
 *
 * ── IT IS DOM-COUPLED, DELIBERATELY ─────────────────────────────────────────
 * It reads MUI class names, `aria-label`s and drawer text. That is brittle by
 * nature and it is the price of the only check that sees what a user sees: a
 * failure here may mean the markup moved rather than the entitlement broke.
 * Read the failing line before believing the product is wrong.
 *
 * Two traps already paid for, both of which made it pass or fail for the wrong
 * reason — keep them in mind before "simplifying" anything below:
 *   · the drawer renders as an icon RAIL with collapsed groups: measured shut
 *     it reports 6 entries and misses 17;
 *   · AppShell PERSISTS group state, and expanding is a TOGGLE, so a second
 *     measurement closes what the first opened. Every measurement resets it.
 */
const fs = require('fs'); const path = require('path'); const http = require('http');
const mongoose = require('mongoose'); const puppeteer = require('puppeteer-core');
const { seed, startEphemeralDatabase } = require('./seed');
const { loadAllModels } = require('./models');
const { readAccounts } = require('./exports');

/** Brick 2's build output — a sibling checkout, never a dependency. */
const DIST = process.env.SPA_DIST
  || path.resolve(__dirname, '../../../frontend/dist');
/** Where the screenshots land; they are the artefact a human actually reads. */
const SHOTS = process.argv[2] || path.resolve(__dirname, '.generated/visual');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const rec = (l, ok, d = '') => { results.push({ l, ok, d }); console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const MIME = { '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.html':'text/html', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.woff2':'font/woff2', '.woff':'font/woff' };

const staticServer = () => http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(DIST, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const api = async (method, p, token, body) => {
  const r = await fetch(`http://localhost:5000${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  const handle = await startEphemeralDatabase();
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  process.env.MONGODB_URI = handle.uri;
  await mongoose.connect(handle.uri); loadAllModels(); await seed({});

  const app = require('../../app');
  const backend = app.listen(5000);
  const spa = staticServer().listen(5173);
  const acc = readAccounts(); const A = acc.campuses.A.id;

  const lg = async (p, b) => (await api('POST', p, null, b)).body.data;
  const admin = await lg('/api/admin/login', { email: 'admin@fixture.test', password: acc.password });
  const mgr = await lg('/api/campus/login', { email: 'campus.a@fixture.test', password: acc.password });

  // Premium so every module is in the offer — we test the USAGE layer here.
  await api('PATCH', `/api/admin/campuses/${A}/entitlement`, admin.token,
    { plan: 'premium', reason: 'visual QA — everything in the offer' });

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t, u) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', JSON.stringify({ ...u, userType: 'manager' }));
    localStorage.setItem('userType', 'manager');
  }, mgr.token, mgr.user);

  /**
   * The dashboard's "Campus Modules" card grid — the SECOND nav surface.
   * Cards are MUI Cards whose first line is the title; the campus profile card
   * ("F", the avatar) is not a module and is dropped.
   */
  const gridCards = async () => {
    await page.goto(`http://localhost:5173/campus/${A}/dashboard`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 3000));
    return page.evaluate(() => {
      const KNOWN = ['Class Management', 'Schedule', 'Subjects & Units', 'Courses Catalog',
        'Exams & Grades', 'Student Reports', 'Student Register', 'Teaching Staff', 'Attendance'];
      const titles = [...document.querySelectorAll('[class*="MuiCard"]')]
        .map((c) => (c.innerText || '').split('\n')[0].trim());
      return KNOWN.filter((k) => titles.includes(k));
    });
  };

  /**
   * The drawer. It renders as an icon rail with six COLLAPSED groups, so the
   * labels only exist once it is opened and every group expanded — measuring it
   * shut reports six entries and misses twenty.
   */
  const navEntries = async () => {
    // AppShell PERSISTS which groups are open (localStorage `appshell_groups`),
    // and expanding is a TOGGLE: without resetting, the second measurement
    // closes what the first opened and reports six entries instead of twenty.
    await page.goto(`http://localhost:5173/campus/${A}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('appshell_groups'));
    await page.goto(`http://localhost:5173/campus/${A}/dashboard`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 3000));
    await page.evaluate(() => {
      const burger = document.querySelector('header button');
      if (burger) burger.click();
    });
    await new Promise((r) => setTimeout(r, 1200));
    // Expand every group header. The clickable is the ListItemButton ANCESTOR of
    // the labelled node, not the labelled node itself; three passes, because
    // expanding one group shifts the ones below it.
    for (let pass = 0; pass < 3; pass++) {
      await page.evaluate(() => {
        const GROUPS = ['People', 'Academic', 'Evaluation', 'Resources', 'Business', 'Personnel'];
        const drawer = document.querySelector('[class*="MuiDrawer"]');
        if (!drawer) return;
        drawer.querySelectorAll('[aria-label]').forEach((el) => {
          if (!GROUPS.includes(el.getAttribute('aria-label'))) return;
          const target = el.closest('[class*="MuiListItemButton"]') || el;
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
        // Fallback: match the uppercase section labels rendered in the open drawer.
        [...drawer.querySelectorAll('[class*="MuiListItemButton"]')].forEach((btn) => {
          const t = (btn.innerText || '').trim().toUpperCase();
          if (GROUPS.map((g) => g.toUpperCase()).includes(t)) {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        });
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
    return page.evaluate(() => {
      const drawer = document.querySelector('[class*="MuiDrawer"]');
      if (!drawer) return [];
      const GROUPS = new Set(['PEOPLE', 'ACADEMIC', 'EVALUATION', 'RESOURCES', 'BUSINESS',
        'PERSONNEL', 'CAMPUS MANAGER']);
      return [...new Set(
        drawer.innerText.split('\n').map((l) => l.trim())
          .filter((l) => l && !GROUPS.has(l))
      )];
    });
  };

  console.log('\n› état initial — tout activé');
  const gridBefore = await gridCards();
  const before = await navEntries();
  await page.screenshot({ path: `${SHOTS}/1-nav-complete.png` });
  rec('le menu latéral est rendu', before.length > 5, `${before.length} : ${before.join(', ')}`);
  rec('la grille du tableau de bord est rendue', gridBefore.length > 5, `${gridBefore.length} : ${gridBefore.join(', ')}`);

  // Which modules can actually be hidden on this campus (data-driven, §6.3.3)?
  console.log('\n› on masque ce que la donnée autorise à masquer');
  const hidden = [];
  for (const key of ['partner', 'academic-print', 'gaet', 'mentor', 'course', 'document']) {
    const r = await api('PATCH', `/api/campus/${A}/entitlement`, mgr.token,
      { modules: [{ key, state: 'hidden', reason: 'visual QA — hiding this module' }] });
    if (r.status < 300) hidden.push(key);
    else console.log(`    (${key} refusé : ${r.body?.errors?.code})`);
  }
  rec('au moins un module a pu être masqué', hidden.length > 0, hidden.join(', '));

  const gridAfter = await gridCards();
  const after = await navEntries();
  await page.screenshot({ path: `${SHOTS}/2-nav-modules-masques.png` });
  // "smaller" is too weak — it passes if the drawer collapses for an unrelated
  // reason. The drop must be EXACTLY the modules that were hidden.
  rec('le menu latéral perd exactement les modules masqués',
      before.length - after.length === hidden.length,
      `${before.length} → ${after.length} (attendu −${hidden.length})`);
  rec('LA GRILLE DU TABLEAU DE BORD a rétréci aussi',
      gridAfter.length < gridBefore.length,
      `${gridBefore.length} → ${gridAfter.length} : ${gridAfter.join(', ')}`);
  rec('aucune carte ne subsiste pour un module masqué',
      !gridAfter.includes('Courses Catalog'),
      gridAfter.includes('Courses Catalog') ? 'la carte « Courses Catalog » est encore là' : 'ok');

  const LABEL = { partner: 'Partners', 'academic-print': 'Print', gaet: 'GAET',
                  mentor: 'Mentors', course: 'Courses', document: 'Documents' };
  const leaks = hidden.filter((k) => after.includes(LABEL[k]));
  rec('aucune entrée de menu ne subsiste pour un module masqué', leaks.length === 0, leaks.join(', ') || 'aucune fuite');

  console.log('\n› accès direct par URL à un module masqué');
  const LINK = { partner: 'partners', 'academic-print': 'print', gaet: 'schedule-gaet',
                 mentor: 'mentors', course: 'courses', document: 'documents' };
  const target = LINK[hidden[0]];
  await page.goto(`http://localhost:5173/campus/${A}/${target}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${SHOTS}/3-url-directe-module-masque.png` });
  const body = await page.evaluate(() => document.body.innerText);
  rec('un écran explicite, pas une page qui se remplit de 403',
      /not activated|non activé|pas activé|nicht|no activ/i.test(body), body.replace(/\s+/g, ' ').slice(0, 110));

  console.log('\n› un module gelé garde son entrée ET annonce son gel');
  const froze = await api('PATCH', `/api/campus/${A}/entitlement`, mgr.token,
    { modules: [{ key: 'result', state: 'read_only', reason: 'visual QA — freezing results' }] });
  rec('gel accepté', froze.status < 300, `${froze.status} ${froze.body?.errors?.code || ''}`);
  const frozenNav = await navEntries();
  rec('le module gelé GARDE son entrée de menu',
      frozenNav.includes('Results'), frozenNav.join(', '));

  await page.goto(`http://localhost:5173/campus/${A}/results`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${SHOTS}/4-module-gele-bandeau.png` });
  const rb = await page.evaluate(() => document.body.innerText);
  rec('le bandeau de gel est affiché',
      /read-only|lecture seule|frozen|gelé/i.test(rb), rb.replace(/\s+/g, ' ').slice(0, 130));
  rec('le bandeau a résolu sa variable (pas de {module} littéral)',
      !/\{\s*module\s*\}/.test(rb), /\{\s*module\s*\}/.test(rb) ? 'VARIABLE NON RÉSOLUE' : 'ok');

  // ── The end user of act 3 — a teacher, on the same campus ────────────────
  // The DoD names this case: a teacher must never learn that a module exists.
  // `course` is hidden above, and the teacher portal declares feature:'course'.
  console.log('\n› portail enseignant — l’utilisateur final de l’acte 3');
  const teacher = await lg('/api/teachers/login', { username: 'teacher.a1', password: acc.password });
  const teacherPage = await browser.newPage();
  await teacherPage.setViewport({ width: 1440, height: 1000 });
  await teacherPage.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await teacherPage.evaluate((t, u) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', JSON.stringify({ ...u, userType: 'teacher' }));
    localStorage.setItem('userType', 'teacher');
    localStorage.removeItem('appshell_groups');
  }, teacher.token, teacher.user);
  await teacherPage.goto('http://localhost:5173/teacher', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  await teacherPage.evaluate(() => {
    const burger = document.querySelector('header button');
    if (burger) burger.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await teacherPage.screenshot({ path: `${SHOTS}/5-portail-enseignant.png` });
  const teacherNav = await teacherPage.evaluate(() => {
    const drawer = document.querySelector('[class*="MuiDrawer"]');
    return drawer ? [...new Set(drawer.innerText.split('\n').map((l) => l.trim()).filter(Boolean))] : [];
  });
  rec('le menu enseignant est rendu', teacherNav.length > 2, teacherNav.join(', '));
  rec('l’enseignant ne voit AUCUNE trace du module masqué',
      !teacherNav.some((l) => /courses?/i.test(l)),
      teacherNav.filter((l) => /courses?/i.test(l)).join(', ') || 'aucune');
  const tBody = await teacherPage.evaluate(() => document.body.innerText);
  rec('aucun bouton mort ni erreur visible sur son tableau de bord',
      !/403|forbidden|error|not activated/i.test(tBody), tBody.replace(/\s+/g, ' ').slice(0, 90));

  console.log('\n› pas d’en-tête de groupe orphelin');
  await page.goto(`http://localhost:5173/campus/${A}/dashboard`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));
  const orphans = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('nav, aside, [class*="drawer"], [class*="sidebar"]').forEach((root) => {
      [...root.querySelectorAll('li, div')].forEach((el) => {
        const t = (el.innerText || '').trim();
        // a short label with no link anywhere under it
        if (t && t.length < 24 && !el.querySelector('a') && el.children.length === 0) out.push(t);
      });
    });
    return [...new Set(out)];
  });
  rec('aucun en-tête de section resté sans entrée', orphans.length === 0, orphans.slice(0, 6).join(' | ') || 'aucun');

  await browser.close(); backend.close(); spa.close();
  await mongoose.disconnect(); await handle.stop();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}\n${results.length - bad.length}/${results.length} contrôles visuels passés`);
  console.log(`captures : ${SHOTS}`);
  if (bad.length) { bad.forEach((r) => console.error(`   - ${r.l}${r.d ? ` — ${r.d}` : ''}`)); process.exitCode = 1; }
})().catch((e) => { console.error('VISUAL QA FAILED:', e); process.exit(2); });
