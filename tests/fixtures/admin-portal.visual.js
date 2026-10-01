'use strict';
/**
 * @file admin-portal.visual.js
 * @description Permanent AP-01–AP-09 browser regressions on the owned disposable fixture.
 * Called by visual.js; login uses the real form. No credentials enter artifacts.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { notDeletedFilter } = require('../../shared/utils/soft-delete');
const { assertTestDatabaseUri } = require('./seed.config');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');

/** Exercise both campuses, persisted creation, optional dates and document workflow reasons. */
async function checkAdminPortal({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1440, height: 1000 });
  const A = accounts.campuses.A.id;
  const B = accounts.campuses.B.id;
  const own = (value) => String(value?._id ?? value);
  const resetBudget = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1'].map(key => apiLimiter.resetKey(key)));
  // Reset only this fixture's loopback budget before its real-form sign-ins.
  const resetLoginBudget = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1'].map(key => loginLimiter.resetKey(key)));
  const settle = () => page.waitForNetworkIdle({ idleTime: 250, timeout: 3000 }).catch(() => {});
  const goto = async route => {
    await resetBudget();
    await page.goto(`http://localhost:5173${route}`, { waitUntil: 'domcontentloaded' });
    await settle();
  };
  const fill = async (selector, value) => {
    const element = await page.waitForSelector(selector, { visible: true });
    await element.click({ count: 3 });
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace'); await element.type(String(value)); await page.keyboard.press('Tab');
  };
  const button = async (label, scope = '') => {
    const element = await page.evaluateHandle((text, parent) => [...document.querySelectorAll(`${parent} button`)]
      .find(e => e.getBoundingClientRect().width && (e.textContent.trim() === text || e.getAttribute('aria-label') === text)), label, scope);
    assert(element.asElement(), `Button missing: ${label}`);
    await element.asElement().click(); await element.dispose();
  };
  const select = async (index, value, scope = '[role="dialog"]') => {
    const items = await page.$$(`${scope} [role="combobox"]`); await items[index].click();
    await page.waitForSelector(`[role="option"][data-value="${value}"]`, { visible: true });
    await page.click(`[role="option"][data-value="${value}"]`);
    await page.waitForSelector('[role="listbox"]', { hidden: true });
  };
  // AuthContext restores the persisted preference after reload; localStorage alone is insufficient.
  const setTheme = async (token, theme) => {
    const response = await fetch('http://localhost:5000/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ theme }),
    });
    assert.equal(response.status, 200);
  };
  const assertTheme = async (target, theme) => {
    await target.waitForFunction(mode => document.documentElement.dataset.theme === mode, {}, theme);
    const brightness = await target.evaluate(() => {
      const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    });
    assert(theme === 'dark' ? brightness < 80 : brightness > 200, `Rendered ${theme} background required`);
  };
  const responseFor = (route, method = 'GET') => page.waitForResponse(r =>
    new URL(r.url()).pathname === `/api/${route}` && r.request().method() === method);
  const scenario = async (label, run) => {
    try { const detail = await run(); record(label, true, detail); }
    catch (error) {
      record(label, false, error.stack?.split('\n').slice(0, 4).join(' ').slice(0, 650));
      if (label.startsWith('AP-06:')) await page.screenshot({ path: path.join(shots, 'finance-failure.png') });
    }
  };
  const paymentMethod = mongoose.model('FeePayment').schema.path('method').enumValues[0];
  const common = JSON.parse(fs.readFileSync(path.join(dist, 'locales/en/common.json')));
  const finance = JSON.parse(fs.readFileSync(path.join(dist, 'locales/en/finance.json')));
  try {
    await resetLoginBudget();
    await goto('/admin/login');
    await fill('#login-identifier', accounts.accounts.global.find(a => a.role === 'ADMIN').login);
    await fill('#login-password', accounts.password);
    const login = responseFor('admin/login', 'POST');
    await page.click('button[type="submit"]');
    const loginResult = await login; assert.equal(loginResult.status(), 200);
    const adminToken = (await loginResult.json()).data.token;
    await page.waitForFunction(() => location.pathname === '/admin/dashboard');
    await setTheme(adminToken, 'light');
    await page.evaluate(() => localStorage.setItem('i18nextLng', 'en'));
    record('AP regression: real administrator form login', true);

    for (const campus of [A, B]) {
      for (const [id, route, apiRoute, modelName, field] of [
        ['AP-01', 'results', 'results', 'Result', 'schoolCampus'],
        ['AP-02', 'notification', 'announcements', 'Announcement', 'schoolCampus'],
        ['AP-05', 'examination', 'examination/sessions', 'ExamSession', 'schoolCampus'],
        ['AP-07', 'documents', 'documents', 'Document', 'campusId'],
        ['AP-08', 'mentors', 'mentors', 'Mentor', 'schoolCampus'],
        ['AP-08', 'staff', 'staff', 'Staff', 'schoolCampus'],
      ]) {
        await scenario(`${id}: ${route} only contains campus ${campus === A ? 'A' : 'B'}`, async () => {
          const pending = responseFor(apiRoute);
          await goto(`/campus/${campus}/${route}`);
          const response = await pending; assert.equal(response.status(), 200);
          const body = await response.json();
          const rows = Array.isArray(body.data) ? body.data : body.data?.sessions;
          assert(Array.isArray(rows) && rows.length > 0, 'Nonempty campus list required');
          assert.equal(new URL(response.url()).searchParams.get('campusId'), campus);
          assert(rows.every(row => own(row[field]) === campus), 'List contains another campus');
          const Model = mongoose.model(modelName);
          const expected = await Model.countDocuments({ [field]: campus, ...notDeletedFilter(Model) });
          assert.equal(body.pagination?.total, expected, 'Campus total must match persisted live records');
        });
      }
    }

    await scenario('AP-03: unconfigured plan has a translated label', async () => {
      await mongoose.model('Campus').updateOne({ _id: B }, { $unset: { entitlement: 1 } });
      await goto('/admin/entitlement');
      const text = await page.$eval('main', e => e.innerText);
      assert(!text.includes('planOption.null'));
      const planLabel = await page.evaluate(() => [...document.querySelectorAll('tbody tr')]
        .find(row => row.innerText.includes('Fixture Campus B'))?.querySelectorAll('td')[1]?.innerText);
      assert.equal(planLabel, common.features.pilot.estate.unconfigured);
      await page.screenshot({ path: path.join(shots, 'admin-plan-light.png') });
    });

    await scenario('AP-02: campus announcement creation persists on A', async () => {
      await goto(`/campus/${A}/notification`); await button('New Announcement');
      await fill('[name="title"]', 'Regression campus announcement');
      await fill('[name="content"]', 'Synthetic announcement for campus context regression.');
      const response = responseFor('announcements', 'POST');
      await page.click('[role="dialog"] button[type="submit"]'); assert.equal((await response).status(), 201);
      const doc = await mongoose.model('Announcement').findOne({ title: 'Regression campus announcement' }).lean();
      assert.equal(own(doc.schoolCampus), A);
    });

    for (const [route, label, model] of [['mentors', 'Add Mentor', 'Mentor'], ['staff', 'Add Staff Member', 'Staff']]) {
      await scenario(`AP-04: ${route} creation persists on A`, async () => {
        await goto(`/campus/${A}/${route}`); await button(label);
        for (const [name, value] of Object.entries({ firstName: `Regression${model}`, lastName: 'Synthetic', username: `regression.${route}`, email: `regression.${route}@fixture.test` })) {
          await fill(`[role="dialog"] input[name="${name}"]`, value);
        }
        const response = responseFor(route, 'POST'); await page.click('[role="dialog"] button[type="submit"]');
        assert.equal((await response).status(), 201);
        const doc = await mongoose.model(model).findOne({ username: `regression.${route}` }).lean();
        assert.equal(own(doc.schoolCampus), A);
        // Navigate away from activation credentials before capturing any artifact.
        await goto(`/campus/${A}/${route}`);
      });
    }
    await scenario('AP-04: partner creation persists on A', async () => {
      await goto(`/campus/${A}/partners`); await button('Add Partner');
      for (const [name, value] of Object.entries({ firstName: 'RegressionPartner', lastName: 'Synthetic', email: 'regression.partner@fixture.test', password: accounts.password })) {
        await fill(`[role="dialog"] [name="${name}"]`, value);
      }
      const input = await page.$('[role="dialog"] input[name="institutionType"]');
      const combo = await input.evaluateHandle(e => e.parentElement.querySelector('[role="combobox"]'));
      await combo.asElement().click(); await page.waitForSelector('[role="option"][data-value="company"]');
      await page.click('[role="option"][data-value="company"]');
      await page.waitForSelector('[role="listbox"]', { hidden: true });
      const response = responseFor('partners/auth/register', 'POST'); await button('Create Partner', '[role="dialog"]');
      assert.equal((await response).status(), 201);
      const doc = await mongoose.model('Partner').findOne({ email: 'regression.partner@fixture.test' }).lean();
      assert.equal(own(doc.schoolCampus), A);
    });

    await scenario('AP-06: empty fee date submits and persists', async () => {
      await goto(`/campus/${A}/finance`); await button('Fees'); await settle(); await button(finance.fees.new);
      const picker = await page.waitForSelector('[role="dialog"] input[role="combobox"]'); await picker.type('StudentA1');
      await page.waitForSelector('[role="option"]');
      const option = await page.evaluateHandle(() => [...document.querySelectorAll('[role="option"]')].find(e => /StudentA1\s/.test(e.textContent)));
      await option.asElement().click();
      await fill('[name="label"]', 'Regression optional date'); await fill('[name="amountDue"]', '10000');
      const response = responseFor('finance/fees', 'POST'); await button(finance.feeForm.submit, '[role="dialog"]');
      assert.equal((await response).status(), 201);
      const doc = await mongoose.model('StudentFee').findOne({ label: 'Regression optional date' }).lean();
      assert.equal(own(doc.schoolCampus), A); assert.equal(doc.dueDate, null);
    });
    await scenario('AP-06: empty payment date submits with correct balance', async () => {
      await goto(`/campus/${A}/finance`); await button('Fees'); await settle();
      const row = await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find(e => e.innerText.includes('Regression optional date')));
      assert(row.asElement(), 'Fee must exist');
      await (await row.$(`button[aria-label="${finance.actions.recordPayment}"]`)).click();
      await fill('[role="dialog"] [name="amount"]', '2500');
      const input = await page.$('[role="dialog"] input[name="method"]');
      const combo = await input.evaluateHandle(e => e.parentElement.querySelector('[role="combobox"]'));
      await combo.asElement().click(); await page.waitForSelector(`[role="option"][data-value="${paymentMethod}"]`); await page.click(`[role="option"][data-value="${paymentMethod}"]`);
      await page.waitForSelector('[role="listbox"]', { hidden: true });
      const fee = await mongoose.model('StudentFee').findOne({ label: 'Regression optional date' }).lean();
      const response = responseFor(`finance/fees/${fee._id}/payments`, 'POST');
      await button(finance.payment.submit, '[role="dialog"]'); assert.equal((await response).status(), 201);
      const updated = await mongoose.model('StudentFee').findById(fee._id).lean();
      assert.equal(updated.amountPaid, 2500); assert.equal(updated.amountDue - updated.amountPaid, 7500);
    });

    await scenario('AP-09: lock, unlock and restore require ten characters', async () => {
      const Model = mongoose.model('Document');
      const doc = await Model.findOne({ campusId: A, status: 'PUBLISHED', ...notDeletedFilter(Model) }).lean();
      assert(doc, 'Published fixture document required');
      for (const action of ['Lock', 'Unlock', 'Archive', 'Restore']) {
        await goto(`/campus/${A}/documents`);
        if (action === 'Restore') await button('Archived');
        await page.waitForFunction(title => [...document.querySelectorAll('tbody tr')].some(e => e.innerText.includes(title)), {}, doc.title);
        const row = await page.evaluateHandle(title => [...document.querySelectorAll('tbody tr')].find(e => e.innerText.includes(title)), doc.title);
        await row.asElement().click(); await settle(); await button(action, '.MuiDrawer-paper');
        await page.waitForSelector('.MuiDialog-paper textarea');
        if (action !== 'Archive') {
          const state = () => page.$eval('.MuiDialog-paper', (e, label) => ({
            text: e.innerText, disabled: [...e.querySelectorAll('button')].find(b => b.textContent.trim() === label)?.disabled,
          }), action);
          assert.equal((await state()).disabled, true, 'Empty reason must disable confirmation');
          assert(!(await state()).text.includes('Reason (optional)'));
          await fill('.MuiDialog-paper textarea', 'short'); assert.equal((await state()).disabled, true);
        }
        await fill('.MuiDialog-paper textarea', 'Synthetic regression reason');
        const response = responseFor(`documents/${doc._id}/${action.toLowerCase()}`, 'POST');
        await button(action, '.MuiDialog-paper'); assert.equal((await response).status(), 200);
      }
      assert.equal((await Model.findById(doc._id).lean()).status, 'DRAFT');
    });

    await scenario('AP-01: closing A leaves B results and transcripts unchanged', async () => {
      const Result = mongoose.model('Result'); const Transcript = mongoose.model('FinalTranscript');
      const beforeB = JSON.stringify(await Result.find({ schoolCampus: B }).sort('_id').lean());
      const beforeTranscriptsB = JSON.stringify(await Transcript.find({ schoolCampus: B }).sort('_id').lean());
      const live = { schoolCampus: A, academicYear: '2025-2026', semester: 'S1', status: { $in: ['PUBLISHED', 'ARCHIVED'] }, ...notDeletedFilter(Result) };
      const expected = await Result.countDocuments({ ...live, periodLocked: false }); assert(expected > 0);
      await goto(`/campus/${A}/results`); await button('Lock Semester');
      await select(0, '2025-2026');
      const response = responseFor('results/lock-semester', 'PATCH'); await button('Lock Semester', '[role="dialog"]');
      const res = await response; assert.equal(res.status(), 200); const body = await res.json();
      assert.equal(body.data.modifiedCount, expected);
      assert(body.data.transcriptsGenerated > 0, 'Campus-filtered aggregation must generate transcripts');
      assert.equal(body.data.transcriptErrors, 0);
      assert.equal(await Result.countDocuments({ ...live, periodLocked: false }), 0);
      assert.equal(JSON.stringify(await Result.find({ schoolCampus: B }).sort('_id').lean()), beforeB);
      assert.equal(JSON.stringify(await Transcript.find({ schoolCampus: B }).sort('_id').lean()), beforeTranscriptsB);
      await settle(); await assertTheme(page, 'light');
      await page.screenshot({ path: path.join(shots, 'admin-results-light.png') });
      await setTheme(adminToken, 'dark');
      await goto(`/campus/${A}/results`); await assertTheme(page, 'dark');
      await page.screenshot({ path: path.join(shots, 'admin-results-dark.png') });
      return `${expected} campus A results locked; ${body.data.transcriptsGenerated} transcripts generated; campus B results and transcripts unchanged`;
    });
    await scenario('Scoped manager: real login and campus results in both themes', async () => {
      const managerContext = await browser.createBrowserContext();
      try {
        const managerPage = await managerContext.newPage();
        managerPage.setDefaultTimeout(12000);
        await managerPage.setCacheEnabled(false);
        await managerPage.setViewport({ width: 1440, height: 1000 });
        await resetBudget();
        await resetLoginBudget();
        await managerPage.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
        await managerPage.click('[data-login-role="manager"]');
        await managerPage.waitForSelector('#login-identifier', { visible: true });
        await managerPage.type('#login-identifier', accounts.accounts.campusA.find(a => a.role === 'CAMPUS_MANAGER').login);
        await managerPage.type('#login-password', accounts.password);
        const loginResponse = managerPage.waitForResponse(r => new URL(r.url()).pathname === '/api/campus/login' && r.request().method() === 'POST');
        await managerPage.click('button[type="submit"]');
        const loginResult = await loginResponse; assert.equal(loginResult.status(), 200);
        const managerToken = (await loginResult.json()).data.token;
        await managerPage.waitForFunction(campus => location.pathname.startsWith(`/campus/${campus}`), {}, A);
        for (const theme of ['light', 'dark']) {
          await setTheme(managerToken, theme);
          const response = managerPage.waitForResponse(r => new URL(r.url()).pathname === '/api/results' && r.request().method() === 'GET');
          await managerPage.goto(`http://localhost:5173/campus/${A}/results`, { waitUntil: 'networkidle2' });
          const res = await response; assert.equal(res.status(), 200);
          const rows = (await res.json()).data;
          assert(rows.length > 0 && rows.every(row => own(row.schoolCampus) === A));
          await assertTheme(managerPage, theme);
          await managerPage.screenshot({ path: path.join(shots, `manager-results-${theme}.png`) });
        }
      } finally { await managerContext.close(); }
    });
  } finally { await context.close(); }
}
module.exports = { checkAdminPortal };
