'use strict';
/* global document, HTMLInputElement, window */
/** @file admission.visual.js @description Real ERP/candidate admission browser acceptance on owned synthetic data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const mongoose = require('mongoose');
const { PDFDocument } = require('pdf-lib');
const { FEATURE_STATES: F } = require('../../shared/constants/features.constants');
const { LEAD_STATUS: S } = require('../../shared/constants/admission.constants');
const { notDeletedFilter } = require('../../shared/utils/soft-delete');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');
const { assertTestDatabaseUri } = require('./seed.config');

/** Exercise actual compiled consumers, separate identities and all commercial states. */
async function checkAdmission({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  await require('../../scripts/prepare-admission').prepareAdmission({ apply: true });
  const A = accounts.campuses.A.id;
  const reset = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1']
    .flatMap((key) => [apiLimiter.resetKey(key), loginLimiter.resetKey(key)]));
  const call = async (method, route, token, body) => {
    await reset();
    const response = await fetch(`http://localhost:5000/api/${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const adminActor = accounts.accounts.global.find((actor) => actor.role === 'ADMIN');
  const admin = (await call('POST', 'admin/login', '', { email: adminActor.login, password: accounts.password })).body.data.token;
  const state = async (partner, portal = F.ENABLED) => {
    const response = await call('PATCH', `admin/campuses/${A}/entitlement`, admin, {
      plan: 'premium', reason: 'Synthetic admission browser acceptance',
      modules: [{ key: 'partner', state: partner, reason: 'Synthetic admission browser acceptance' },
        { key: 'public-portal', state: portal, reason: 'Synthetic admission browser acceptance' }],
    });
    assert.equal(response.status, 200);
  };
  const Lead = mongoose.model('PartnerLead');
  const Campus = mongoose.model('Campus');
  const Student = mongoose.model('Student');
  const klass = await mongoose.model('Class').findOne({ schoolCampus: A, ...notDeletedFilter(mongoose.model('Class')) }).lean();
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Synthetic admission browser evidence');
  const filePath = path.join(process.cwd(), 'synthetic-admission.pdf');
  fs.writeFileSync(filePath, Buffer.from(await pdf.save()));
  const button = async (page, text, selector = 'button') => {
    const handle = await page.evaluateHandle((label, scope) => [...document.querySelectorAll(scope)]
      .find((element) => element.textContent.trim() === label), text, selector);
    assert(handle.asElement(), `Missing translated action: ${text}`);
    await handle.asElement().click(); await handle.dispose();
  };
  const select = async (page, id, value) => {
    await page.click(`#${id}`);
    const option = `[role="option"][data-value="${value}"]`;
    await page.waitForSelector(option, { visible: true });
    await page.click(option);
    await page.waitForSelector('[role="listbox"]', { hidden: true });
  };
  const setInput = async (page, name, value) => page.$eval(`input[name="${name}"]`, (element, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  let child;
  const originalPortalUrl = process.env.PORTAL_URL;
  try {
    for (const role of ['ADMIN', 'CAMPUS_MANAGER']) {
      for (const theme of ['light', 'dark']) {
        await state(F.ENABLED);
        const actor = Object.values(accounts.accounts).flat().find((item) => item.role === role && (!item.campusId || item.campusId === A));
        const lead = await Lead.create({ firstName: 'Synthetic', lastName: `Browser-${role}-${theme}`, email: `browser-${role.toLowerCase()}-${theme}@fixture.test`,
          phone: '+237600000010', schoolCampus: A, source: 'direct' });
        const context = await browser.createBrowserContext(); const page = await context.newPage();
        page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
        await page.setViewport({ width: 1440, height: 1000 });
        let catalog;
        let phase = 'login navigation';
        const scenario = async (label, work) => {
          try { await work(); record(`Admission: ${role}/${theme}: ${label}`, true); }
          catch (error) { record(`Admission: ${role}/${theme}: ${label}`, false, error.message); }
        };
        const openLead = async () => {
          await reset(); await page.goto(`http://localhost:5173/campus/${A}/partners`, { waitUntil: 'networkidle2' });
          await page.waitForSelector('[role="tab"]');
          await page.$$eval('[role="tab"]', (tabs) => tabs[1].click());
          await page.waitForFunction((name) => [...document.querySelectorAll('tr')].some((row) => row.innerText.includes(name)), {}, lead.lastName);
          await page.evaluate((name) => [...document.querySelectorAll('tr')].find((row) => row.innerText.includes(name)).querySelector('button').click(), lead.lastName);
          await page.waitForSelector('[data-testid="admission-dossier"]');
          await page.waitForFunction(() => !!document.querySelector('#admission-requirements'));
        };
        try {
          await reset(); await page.goto(`http://localhost:5173${role === 'ADMIN' ? '/admin/login' : '/login'}`, { waitUntil: 'networkidle2' });
          phase = 'login form';
          if (role === 'CAMPUS_MANAGER') await page.click('[data-login-role="manager"]');
          await page.type('#login-identifier', actor.login); await page.type('#login-password', actor.password);
          phase = 'login response';
          const loginPath = actor.endpoint.includes(' ') ? actor.endpoint.split(' ')[1] : actor.endpoint;
          const login = page.waitForResponse((response) => response.url().endsWith(loginPath) && response.request().method() === 'POST');
          await page.click('button[type="submit"]'); assert.equal((await login).status(), 200);
          phase = 'authenticated profile';
          await page.waitForSelector('[aria-controls="profile-menu"]');
          const token = await page.evaluate(() => localStorage.getItem('token'));
          await call('PATCH', 'settings', token, { theme });
          const locale = await page.evaluate(() => JSON.parse(localStorage.getItem('user')).preferredLanguage || 'en');
          catalog = JSON.parse(fs.readFileSync(path.join(dist, 'locales', locale, 'common.json'))).admission;
          phase = 'lead drawer'; await openLead();
          await scenario('private dossier renders in the persisted theme and uploads a real file', async () => {
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
            await page.waitForFunction(() => {
              const control = document.querySelector('[data-testid="admission-file"]')?.closest('label');
              return control && control.getAttribute('aria-disabled') !== 'true' && !control.classList.contains('Mui-disabled');
            });
            const uploaded = page.waitForResponse((response) => response.url().endsWith('/dossier/files') && response.request().method() === 'POST');
            await (await page.$('[data-testid="admission-file"]')).uploadFile(filePath);
            assert.equal((await uploaded).status(), 201);
            await page.waitForFunction(() => document.querySelector('[data-testid="admission-dossier"]').innerText.includes('synthetic-admission.pdf'));
            await page.screenshot({ path: path.join(shots, `admission-${role.toLowerCase()}-${theme}.png`) });
          });
          await scenario('submission freezes files and only director/admin can admit', async () => {
            const submitted = page.waitForResponse((response) => response.url().endsWith(`/leads/${lead._id}/status`) && response.request().method() === 'PATCH');
            await button(page, catalog.status.dossier_submitted); assert.equal((await submitted).status(), 200);
            await page.waitForFunction((text) => document.querySelector('[data-testid="admission-status"]').textContent.includes(text), {}, catalog.status.dossier_submitted);
            assert.equal(await page.$('[data-testid="admission-file"]'), null);
            const canAdmit = await page.$$eval('[data-testid="admission-dossier"] button', (elements, label) => elements.some((element) => element.textContent.trim() === label), catalog.status.admitted);
            assert.equal(canAdmit, role === 'ADMIN');
            if (role === 'ADMIN') {
              const admitted = page.waitForResponse((response) => response.url().endsWith(`/leads/${lead._id}/status`) && response.request().method() === 'PATCH');
              await button(page, catalog.status.admitted); assert.equal((await admitted).status(), 200);
            } else {
              const current = await Lead.findById(lead._id).lean();
              assert.equal((await call('PATCH', `partners/leads/${lead._id}/status`, admin, { status: S.ADMITTED, revision: current.dossier.revision })).status, 200);
              await openLead();
            }
            await page.waitForSelector('input[name="dateOfBirth"]');
          });
          await scenario('finalization creates one pending student and shows activation once', async () => {
            await setInput(page, 'username', `browser.${role === 'ADMIN' ? 'a' : 'm'}.${theme}`);
            await setInput(page, 'dateOfBirth', '2005-01-01');
            await select(page, 'admission-gender', 'female'); await select(page, 'admission-studentClass', String(klass._id));
            const enrolled = page.waitForResponse((response) => response.url().endsWith(`/leads/${lead._id}/status`) && response.request().method() === 'PATCH');
            await button(page, catalog.enrollment); const response = await enrolled; assert.equal(response.status(), 200);
            const result = (await response.json()).data;
            assert.equal(result.student.status, 'pending'); assert(result.activation?.code);
            const dialog = '.MuiDialog-root [role="dialog"]';
            await page.waitForSelector(dialog, { visible: true });
            assert(await page.$eval(dialog, (element, title) => element.innerText.includes(title), catalog.activation.title), 'Activation dialog uses the loaded locale');
            await button(page, catalog.close, `${dialog} button`);
            await page.waitForSelector(dialog, { hidden: true });
            assert.equal(await Student.countDocuments({ _id: result.student._id }), 1);
            await page.screenshot({ path: path.join(shots, `admission-enrolled-${role.toLowerCase()}-${theme}.png`) });
            await openLead();
            assert.equal(await page.$(dialog), null, 'Reloading enrollment does not reveal activation again');
          });
          for (const mode of [F.READ_ONLY, F.HIDDEN]) {
            await state(mode);
            await scenario(`${mode} preserves the global-role rule and scoped refusal`, async () => {
              await reset(); await page.goto(`http://localhost:5173/campus/${A}/partners`, { waitUntil: 'networkidle2' });
              if (role === 'CAMPUS_MANAGER' && mode === F.HIDDEN) {
                assert.equal(await page.$('[data-testid="admission-dossier"]'), null);
                assert.equal(await page.$$eval('[role="tab"]', (elements) => elements.length), 0);
              } else {
                await openLead();
                const disabled = await page.$$eval('[data-testid="admission-dossier"] button', (elements, label) => elements.find((element) => element.textContent.trim() === label)?.disabled, catalog.sendAccess);
                assert.equal(disabled, role === 'CAMPUS_MANAGER');
                const response = await call('POST', `partners/leads/${lead._id}/dossier/access`, token, {});
                assert.equal(response.status, role === 'CAMPUS_MANAGER' ? 403 : 200);
              }
              await page.screenshot({ path: path.join(shots, `admission-${mode}-${role.toLowerCase()}-${theme}.png`) });
            });
          }
        } catch (error) { error.message = `${role}/${theme}/${phase}: ${error.message}`; throw error; }
        finally { await context.close(); }
      }
    }

    await state(F.ENABLED);
    const portalRoot = path.resolve(process.env.PORTAL_ROOT || path.resolve(__dirname, '../../../../partner'));
    assert(fs.existsSync(path.join(portalRoot, '.next/BUILD_ID')), 'A current portal build is required');
    await Campus.updateOne({ _id: A }, { $set: { campusSlug: 'admission-browser' } });
    const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`; process.env.PORTAL_URL = origin;
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: portalRoot, stdio: ['ignore', 'ignore', 'ignore'], env: {
        ...process.env, NODE_ENV: 'production', ERP_API_URL: 'http://localhost:5000', PORTAL_API_KEY: process.env.PORTAL_API_KEY,
        NEXT_PUBLIC_PORTAL_URL: origin, DEFAULT_CAMPUS_SLUG: 'admission-browser',
      },
    });
    const deadline = Date.now() + 30000;
    while (true) {
      try { if ((await fetch(origin + '/en/admission')).ok) break; } catch { /* Wait for the owned server to bind. */ }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Owned candidate portal did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (const locale of ['fr', 'ar']) {
      const context = await browser.createBrowserContext(); const page = await context.newPage();
      page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
      await page.setViewport({ width: locale === 'ar' ? 390 : 1280, height: 1000 });
      const labels = JSON.parse(fs.readFileSync(path.join(portalRoot, 'src/messages', `${locale}.json`))).admission;
      const lead = await Lead.create({ firstName: 'Synthetic', lastName: `Candidate-${locale}`, email: `candidate-${locale}@fixture.test`, schoolCampus: A, source: 'direct' });
      await require('../../modules/partner').service.admissionAccess.issueAccess(lead._id);
      const mail = await mongoose.model('Notification').findOne({ recipientId: lead._id, template: 'admission.access' }).select('+privatePayload').lean();
      const privateLink = require('../../modules/notification/notification.private').reveal(mail).data.link;
      const fragment = new URL(privateLink).hash;
      const scenario = async (label, work) => {
        try { await work(); record(`Admission candidate/${locale}: ${label}`, true); return true; }
        catch (error) { record(`Admission candidate/${locale}: ${label}`, false, error.message); return false; }
      };
      try {
        const ready = await scenario('private fragment becomes an HttpOnly cookie without storage or URL leakage', async () => {
          const exchange = page.waitForResponse((response) => response.url().endsWith('/api/admission/session') && response.request().method() === 'POST');
          exchange.catch(() => {});
          await page.goto(`${origin}/${locale}/admission${fragment}`, { waitUntil: 'networkidle2' });
          const response = await exchange;
          assert.equal(response.status(), 200, `Candidate session exchange: HTTP ${response.status()}`);
          await page.waitForFunction(() => document.querySelector('[data-testid="candidate-status"]'));
          assert(!page.url().includes('#access='));
          const cookie = (await context.cookies(origin + '/api/admission/dossier')).find((item) => item.name === 'admission_access');
          assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
          assert.equal(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length), 0);
          assert.equal(await page.evaluate(() => document.documentElement.dir), locale === 'ar' ? 'rtl' : 'ltr');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        });
        if (!ready) continue;
        await scenario('a concurrent edit refreshes the revision before an explicit upload retry', async () => {
          await Lead.updateOne({ _id: lead._id }, { $inc: { 'dossier.revision': 1 } });
          const conflict = page.waitForResponse((response) => response.url().endsWith('/api/admission/dossier/files') && response.request().method() === 'POST');
          await (await page.$('#candidate-file')).uploadFile(filePath); assert.equal((await conflict).status(), 409);
          await page.waitForSelector('[role="alert"]');
          await page.waitForFunction(() => !document.querySelector('#candidate-file').disabled);
          const retried = page.waitForResponse((response) => response.url().endsWith('/api/admission/dossier/files') && response.request().method() === 'POST');
          await (await page.$('#candidate-file')).uploadFile(filePath); assert.equal((await retried).status(), 200);
        });
        // An independent reload prevents one failed conflict check from poisoning later checks.
        await page.reload({ waitUntil: 'networkidle2' });
        await page.waitForSelector('[data-testid="candidate-status"]');
        await scenario('real candidate upload and submission update the owned dossier', async () => {
          const uploaded = page.waitForResponse((response) => response.url().endsWith('/api/admission/dossier/files') && response.request().method() === 'POST');
          await (await page.$('#candidate-file')).uploadFile(filePath); assert.equal((await uploaded).status(), 200);
          await page.waitForFunction(() => document.querySelector('[data-testid="candidate-dossier"]').innerText.includes('synthetic-admission.pdf'));
          const submitted = page.waitForResponse((response) => response.url().endsWith('/api/admission/dossier/submit'));
          await button(page, labels.submit); assert.equal((await submitted).status(), 200);
          await page.waitForFunction((text) => document.querySelector('[data-testid="candidate-status"]').textContent === text, {}, labels.status.dossier_submitted);
          await page.screenshot({ path: path.join(shots, `admission-candidate-${locale}.png`) });
        });
        await scenario('read-only keeps the dossier readable; hidden removes it; revoked access is refused', async () => {
          await state(F.ENABLED, F.READ_ONLY); await page.reload({ waitUntil: 'networkidle2' });
          await page.waitForFunction((text) => document.body.innerText.includes(text), {}, labels.closed);
          await page.screenshot({ path: path.join(shots, `admission-candidate-read-only-${locale}.png`) });
          await state(F.ENABLED, F.HIDDEN); await page.reload({ waitUntil: 'networkidle2' });
          await page.waitForFunction((text) => document.body.innerText.includes(text), {}, labels.invalidAccess);
          await state(F.ENABLED); await require('../../modules/partner').service.admissionAccess.revokeAccess(lead._id);
          await page.reload({ waitUntil: 'networkidle2' });
          await page.waitForFunction((text) => document.body.innerText.includes(text), {}, labels.invalidAccess);
        });
      } finally { await context.close(); }
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (originalPortalUrl === undefined) delete process.env.PORTAL_URL; else process.env.PORTAL_URL = originalPortalUrl;
    await state(F.ENABLED).catch(() => {});
  }
}
module.exports = { checkAdmission };
