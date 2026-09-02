'use strict';

/**
 * @file visual.js
 * @description The browser half of the QA — what only a rendered page can
 * answer. Two acts, one process:
 *
 *   1. entitlement — which entries a campus actually DRAWS
 *      (`docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §15, DoD);
 *   2. fee receipts — the file a STUDENT actually OBTAINS, in both themes and
 *      under the three entitlement states
 *      (`docs/architecture/features/fee-receipts-and-reminders.md` §8, the
 *      browser-QA step of the §12 pattern).
 *
 * Both acts are here rather than in a second harness because they need the same
 * expensive scaffolding — a replica set, the fixture, the real API and a built
 * SPA — and because a screen is where their two failure modes meet: a module
 * that is drawn but dead, and a download that arrives under the wrong name.
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
const { apiLimiter } = require('../../shared/middleware/rate-limiter');

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
  // A browser that exits mid-run leaves every pending navigation waiting
  // forever: twenty minutes of silence that reads as a slow check rather than
  // as a dead process. Say so, and stop. `closing` tells the intentional close
  // at the end from a crash.
  let closing = false;
  browser.on('disconnected', () => {
    if (closing) return;
    console.error('\nVISUAL QA FAILED: the browser exited mid-run (out of memory?)');
    process.exit(2);
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  /**
   * Seeds a session into the SPA's storage. The harness never drives the login
   * FORM — that is another screen's concern, and a change to it would break
   * every check below for a reason none of them is about.
   *
   * `theme` is written to the colour-mode store's own key (`erp_theme`,
   * `themeMode.js`) rather than toggled after the fact, so the page BOOTS in
   * that mode: a theme switched after the first paint proves the toggle works,
   * not that the screen renders correctly under it.
   */
  const signIn = async (target, session, userType, theme = 'light') => {
    await target.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await target.evaluate((t, u, type, mode) => {
      localStorage.setItem('token', t);
      localStorage.setItem('user', JSON.stringify({ ...u, userType: type }));
      localStorage.setItem('userType', type);
      localStorage.setItem('erp_theme', mode);
      localStorage.removeItem('appshell_groups');
    }, session.token, session.user, userType, theme);
  };

  await signIn(page, mgr, 'manager');

  /**
   * A page with a STORAGE of its own.
   *
   * Every portal below signs in as a different person on the same origin, and
   * `localStorage` belongs to the origin rather than to the tab: share one
   * browser context and the last sign-in becomes the identity of every open
   * page — a manager screen answering "Access Denied" because a student signed
   * in three lines earlier, which is exactly how this was found.
   */
  const portalPage = async () => {
    const context = await browser.createBrowserContext();
    const fresh = await context.newPage();
    await fresh.setViewport({ width: 1440, height: 1000 });
    return fresh;
  };

  /**
   * Gives the run its per-IP request budget back.
   *
   * `app.js` meters every `/api/` route at 100 requests per 15 minutes and per
   * ADDRESS (`apiLimiter`), and one browser pass spends that on page loads
   * alone: a dashboard fans out into a dozen calls, and this harness renders a
   * dozen dashboards. Past the budget the API answers 429 to everything, the
   * sign-ins included, and the act that follows fails for a reason it is not
   * about. Reset between acts rather than metered away: the per-user budget
   * that actually protects the PDF pool is asserted where it belongs, in
   * `tests/integration/finance.receipt.test.js`.
   */
  const resetApiBudget = async () => {
    // Loopback reaches the server as either form depending on how the client
    // resolved `localhost`; resetting an unknown key is a no-op.
    await Promise.all(['::/56', '127.0.0.1'].map((key) => apiLimiter.resetKey(key)));
  };

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
  const teacherPage = await portalPage();
  await signIn(teacherPage, teacher, 'teacher');
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

  // Its renderer is dead weight from here on, and the act that follows opens
  // two more portals on a machine that already runs a replica set, the API and
  // the PDF pool's own Chrome.
  await teacherPage.browserContext().close();

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

  // ── Act 2 — the fee receipt and its three entitlement states ────────────────
  // Browser-QA step of phase 1-B line 6
  // (`docs/architecture/features/fee-receipts-and-reminders.md` §8).
  //
  // What only a rendered page answers here, and no supertest can:
  //   · the receipt is fetched CROSS-ORIGIN (SPA :5173, API :5000 — the shape of
  //     the deployment, front on Vercel and API elsewhere), so the browser hides
  //     from the SPA every response header the API does not EXPOSE. The file
  //     that lands on the disk is where that shows;
  //   · a STUDENT is the only non-management role that can obtain a PDF at all;
  //   · `read_only` must keep the receipt reachable — it is a GET — while
  //     refusing everything that writes.
  await resetApiBudget();

  const DL = path.join(SHOTS, 'downloads');
  fs.mkdirSync(DL, { recursive: true });
  const clearDownloads = () =>
    fs.readdirSync(DL).forEach((f) => fs.unlinkSync(path.join(DL, f)));

  /**
   * Every shipped translation of one i18n key.
   *
   * The fixture's accounts do not read English, and asserting on an English
   * string made three checks fail on a screen that was perfectly correct. The
   * harness therefore asks the SAME catalogue the SPA loads (`dist/locales`),
   * which makes a check independent of the reader's locale AND, as a
   * by-product, red on a raw key left on screen.
   */
  const translations = (ns, dotted) => fs.readdirSync(path.join(DIST, 'locales'))
    .map((lng) => {
      try {
        return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]),
          JSON.parse(fs.readFileSync(path.join(DIST, 'locales', lng, `${ns}.json`), 'utf8')));
      } catch { return null; }
    })
    .filter((v) => typeof v === 'string');

  const RECEIPT_LABEL  = translations('finance', 'receipt.download');
  const LEDGER_TITLE   = translations('finance', 'student.title');
  const FINANCE_TITLE  = translations('finance', 'title');
  const NOT_ACTIVATED  = translations('common', 'features.notActivatedTitle');
  const says = (body, candidates) => candidates.some((s) => body.includes(s));

  /**
   * What a portal's MENU offers, burger opened.
   *
   * Not the page text: the breadcrumb of `/student/finance` says "Finance" even
   * when the module is hidden, so a body-wide search answers yes in both
   * directions. Not `a[href]` either — the shell navigates on click and renders
   * no anchors. The drawer's own text is the affordance, and the entries are
   * declared in English in the portal's menu config, so it survives the
   * reader's locale.
   */
  const drawerText = async (target) => {
    await target.evaluate(() => {
      const burger = document.querySelector('header button');
      if (burger) burger.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    return target.evaluate(() => {
      const drawer = document.querySelector('[class*="MuiDrawer"]');
      return drawer ? drawer.innerText.replace(/\s+/g, ' ').trim() : '';
    });
  };

  /** Chrome writes downloads nowhere unless told to; `Browser` is the supported
   *  domain, `Page` its deprecated predecessor kept for an older binary. */
  const armDownloads = async (target) => {
    // `browserContextId` is not optional here: omitted, the behaviour is set on
    // the DEFAULT context only, and every portal below runs in a context of its
    // own (see `portalPage`). The click then fires, the request succeeds, and
    // the file is silently dropped — a download that looks like a broken route.
    const browserContextId = target.browserContext().id;
    try {
      const session = await browser.target().createCDPSession();
      await session.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: DL, eventsEnabled: true,
        ...(browserContextId ? { browserContextId } : {}),
      });
      return;
    } catch { /* fall through to the deprecated form */ }
    const session = await target.createCDPSession();
    await session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  };

  /** The finished file name, or null. `.crdownload` is Chrome still writing. */
  const waitForDownload = async (ms = 20000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const done = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
      if (done.length) return done[0];
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };

  /**
   * The receipt BUTTONS of the rendered page.
   *
   * `ReceiptButton` wraps its `IconButton` in a tooltip whose span carries the
   * same `aria-label` — two labelled nodes for one affordance. Counting nodes
   * reports a duplicated icon that nobody can see, and, worse, CLICKING the
   * first labelled node clicks the span: nothing happens, and the check reads
   * as "the download is broken" while the button was never pressed.
   */
  const receiptButtons = async (target) => target.evaluate((labels) =>
    [...new Set([...document.querySelectorAll('[aria-label]')]
      .filter((n) => labels.includes(n.getAttribute('aria-label')))
      .map((n) => n.closest('button'))
      .filter(Boolean))].length, RECEIPT_LABEL);

  const clickReceipt = async (target) => target.evaluate((labels) => {
    const button = [...document.querySelectorAll('[aria-label]')]
      .filter((n) => labels.includes(n.getAttribute('aria-label')))
      .map((n) => n.closest('button'))
      .find(Boolean);
    if (!button) return false;
    button.click();
    return true;
  }, RECEIPT_LABEL);

  /** Perceived brightness of the page's own ground — a screen that ignores the
   *  colour mode renders light whatever the preference says. */
  const bodyLuma = async (target) => target.evaluate(() => {
    const rgb = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]).map(Number);
    return Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
  });

  /**
   * Switches a signed-in account to a colour mode the way a user does — through
   * their stored PREFERENCE.
   *
   * Writing `erp_theme` into `localStorage` looks equivalent and is not:
   * `AuthContext` re-applies `UserPreferences.theme` on every reload and on its
   * background resync, so a mode set from the outside is overwritten within the
   * second. What is verified here is the product's own path.
   */
  const setTheme = async (token, theme) => api('PATCH', '/api/settings', token, { theme });

  console.log('\n› frais — le relevé de l’étudiant, thème clair');
  // WHICH student holds a settled debt is a property of the fixture's counts,
  // not of a name: debts are handed out round-robin and the first student draws
  // the unpaid one. Read the pair from the database rather than hard-code
  // `student.a1` and get a green run on an empty ledger.
  const seededPayments = await mongoose.model('FeePayment').find({ schoolCampus: A }).lean();
  const payer = await mongoose.model('Student').findOne({
    _id: { $in: seededPayments.map((p) => p.student) },
    status: 'active',
  }).lean();
  rec('la fixture porte un encaissement rattaché à un compte actif', !!payer,
      payer ? `${payer.username} — ${seededPayments.length} encaissement(s) sur le campus` : 'aucun');

  const student = await lg('/api/students/login', { username: payer.username, password: acc.password });
  const ledger = (await api('GET', '/api/finance/my/ledger', student.token)).body?.data || {};
  const payments = ledger.payments || [];
  const paymentId = payments.length ? String(payments[0]._id || payments[0].id) : '';
  rec('son relevé porte le paiement que la base annonce', payments.length > 0,
      `${payments.length} paiement(s), ${(ledger.fees || []).length} dette(s)`);

  const studentPage = await portalPage();
  await signIn(studentPage, student, 'student');
  await studentPage.goto('http://localhost:5173/student/finance', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  await studentPage.screenshot({ path: `${SHOTS}/6-etudiant-frais-clair.png` });

  const studentBody = await studentPage.evaluate(() => document.body.innerText);
  rec('le relevé de l’étudiant est rendu, dans SA langue', says(studentBody, LEDGER_TITLE),
      studentBody.replace(/\s+/g, ' ').slice(0, 110));
  const icons = await receiptButtons(studentPage);
  rec('chaque paiement porte son bouton de reçu', icons === payments.length && icons > 0,
      `${icons} bouton(s) pour ${payments.length} paiement(s)`);

  console.log('\n› frais — le reçu part vraiment, et sous le nom que le serveur a choisi');
  await armDownloads(studentPage);
  clearDownloads();
  const clicked = await clickReceipt(studentPage);
  const file = clicked ? await waitForDownload() : null;
  rec('le clic produit un fichier', !!file, file || 'aucun fichier reçu');
  if (file) {
    const bytes = fs.readFileSync(path.join(DL, file));
    rec('le fichier est un PDF non vide',
        bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000,
        `${bytes.subarray(0, 5).toString()} — ${bytes.length} octets`);
    // The hook falls back to `receipt-<paymentId>.pdf` when it cannot read the
    // server's Content-Disposition. Cross-origin, that header only reaches the
    // SPA if the API EXPOSES it: the fallback name is what a missing
    // `exposedHeaders` entry looks like from the outside.
    rec('le nom du fichier porte le NUMÉRO de reçu, pas l’id du paiement',
        !!paymentId && !file.includes(paymentId), file);
  }
  const afterDownload = await studentPage.evaluate(() => document.body.innerText);
  rec('aucune erreur affichée après le téléchargement',
      !says(afterDownload, translations('finance', 'receipt.error')), 'ok');

  console.log('\n› frais — thème sombre, sur les deux écrans');
  await setTheme(student.token, 'dark');
  await studentPage.goto('http://localhost:5173/student/finance', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3500));
  await studentPage.screenshot({ path: `${SHOTS}/7-etudiant-frais-sombre.png` });
  const studentLuma = await bodyLuma(studentPage);
  rec('le relevé de l’étudiant suit le thème sombre', studentLuma < 90, `luminance ${studentLuma}`);

  await setTheme(mgr.token, 'dark');
  await page.goto(`http://localhost:5173/campus/${A}/finance`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3500));
  await page.screenshot({ path: `${SHOTS}/8-campus-frais-sombre.png` });
  const mgrFinanceBody = await page.evaluate(() => document.body.innerText);
  const mgrLuma = await bodyLuma(page);
  rec('l’écran finance du gestionnaire est rendu', says(mgrFinanceBody, FINANCE_TITLE),
      mgrFinanceBody.replace(/\s+/g, ' ').slice(0, 90));
  rec('l’écran finance du gestionnaire suit le thème sombre', mgrLuma < 90, `luminance ${mgrLuma}`);

  console.log('\n› frais gelés — l’historique reste lisible, le reçu reste téléchargeable');
  const frozenFinance = await api('PATCH', `/api/campus/${A}/entitlement`, mgr.token,
    { modules: [{ key: 'finance', state: 'read_only', reason: 'visual QA — freezing finance' }] });
  rec('gel de finance accepté', frozenFinance.status < 300,
      `${frozenFinance.status} ${frozenFinance.body?.errors?.code || ''}`);

  await page.goto(`http://localhost:5173/campus/${A}/finance`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: `${SHOTS}/9-campus-frais-geles.png` });
  const frozenBody = await page.evaluate(() => document.body.innerText);
  rec('le bandeau de gel est affiché sur finance',
      /read-only|lecture seule|frozen|gelé/i.test(frozenBody), frozenBody.replace(/\s+/g, ' ').slice(0, 120));

  await studentPage.goto('http://localhost:5173/student/finance', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  await studentPage.screenshot({ path: `${SHOTS}/10-etudiant-frais-geles.png` });
  const frozenStudent = await studentPage.evaluate(() => document.body.innerText);
  rec('un module gelé laisse le relevé de l’étudiant lisible', says(frozenStudent, LEDGER_TITLE),
      frozenStudent.replace(/\s+/g, ' ').slice(0, 110));
  clearDownloads();
  const clickedFrozen = await clickReceipt(studentPage);
  const frozenFile = clickedFrozen ? await waitForDownload() : null;
  rec('le reçu reste téléchargeable sous gel — c’est une lecture', !!frozenFile,
      frozenFile || 'aucun fichier reçu');

  console.log('\n› frais masqués — les trois états, dont celui que la donnée refuse');
  await resetApiBudget();
  const hideWithRecords = await api('PATCH', `/api/campus/${A}/entitlement`, mgr.token,
    { modules: [{ key: 'finance', state: 'hidden', reason: 'visual QA — hiding finance' }] });
  rec('masquer un module qui porte des écritures est refusé, pas appliqué à moitié',
      hideWithRecords.status === 409
        && hideWithRecords.body?.errors?.code === 'FEATURE_HAS_RECORDS',
      `${hideWithRecords.status} ${hideWithRecords.body?.errors?.code || ''}`);

  // The third state, SEEN rather than deduced. `finance` declares `FeePayment`
  // and `Income` as its records, so campus B's are removed first — in a database
  // whose entire life is this process — and the module is then hidden the way it
  // would be on a campus that never used it. Campus A keeps its own untouched.
  const B = acc.campuses.B.id;
  const mgrB = await lg('/api/campus/login', { email: 'campus.b@fixture.test', password: acc.password });
  await api('PATCH', `/api/admin/campuses/${B}/entitlement`, admin.token,
    { plan: 'premium', reason: 'visual QA — campus B in the offer too' });
  const studentB = await lg('/api/students/login', { username: 'student.b1', password: acc.password });
  const pageB = await portalPage();
  await signIn(pageB, studentB, 'student');
  await pageB.goto('http://localhost:5173/student/finance', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  const menuBefore = await drawerText(pageB);
  rec('avant masquage, le menu de l’étudiant B PORTE son entrée Finance',
      /finance/i.test(menuBefore), menuBefore.slice(0, 120) || 'menu introuvable');

  await Promise.all([
    mongoose.model('FeePayment').deleteMany({ schoolCampus: B }),
    mongoose.model('Income').deleteMany({ schoolCampus: B }),
  ]);
  const hideB = await api('PATCH', `/api/campus/${B}/entitlement`, mgrB.token,
    { modules: [{ key: 'finance', state: 'hidden', reason: 'visual QA — hiding finance, no entries left' }] });
  rec('sans écriture, le masquage est accepté', hideB.status < 300,
      `${hideB.status} ${hideB.body?.errors?.code || ''}`);

  await pageB.goto('http://localhost:5173/student/finance', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3000));
  await pageB.screenshot({ path: `${SHOTS}/11-etudiant-b-finance-masquee.png` });
  const menuAfter = await drawerText(pageB);
  const bodyB = await pageB.evaluate(() => document.body.innerText);
  rec('le menu ne porte plus AUCUNE entrée Finance',
      !!menuAfter && !/finance/i.test(menuAfter), menuAfter.slice(0, 120) || 'menu introuvable');
  rec('l’URL directe donne un écran explicite, pas une page qui se remplit de 403',
      says(bodyB, NOT_ACTIVATED), bodyB.replace(/\s+/g, ' ').slice(0, 110));

  closing = true;
  await browser.close(); backend.close(); spa.close();
  await mongoose.disconnect(); await handle.stop();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}\n${results.length - bad.length}/${results.length} contrôles visuels passés`);
  console.log(`captures : ${SHOTS}`);
  if (bad.length) { bad.forEach((r) => console.error(`   - ${r.l}${r.d ? ` — ${r.d}` : ''}`)); process.exitCode = 1; }
})().catch((e) => { console.error('VISUAL QA FAILED:', e); process.exit(2); });
