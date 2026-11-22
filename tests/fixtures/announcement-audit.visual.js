'use strict';

/** @file announcement-audit.visual.js @description Rendered announcement workflow and persisted audit checks in two roles and themes. */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const mongoose = require('mongoose');
const { prepareAuditJournal } = require('../../scripts/prepare-audit-journal');
const { assertTestDatabaseUri } = require('./seed.config');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');
const { constants: { MODE } } = require('../../modules/audit');
const { STATUS } = require('../../modules/announcement/announcement.constants');

/** Exercise the existing consumer via rendered controls; no journal consultation UI is implied. */
async function checkAnnouncementAudit({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  await prepareAuditJournal({ apply: true });
  const labels = JSON.parse(fs.readFileSync(path.join(dist, 'locales/en/announcements.json')));
  const common = JSON.parse(fs.readFileSync(path.join(dist, 'locales/en/common.json')));
  const campus = accounts.campuses.A.id;
  const Announcement = mongoose.model('Announcement'); const AuditEvent = mongoose.model('AuditEvent');
  const Campus = mongoose.model('Campus');
  const previous = await Campus.findById(campus).select('entitlement').lean();
  await Campus.updateOne({ _id: campus }, { $set: { 'entitlement.plan': 'premium', 'entitlement.modules': [] } });
  require('../../shared/lib/entitlement').cache.clear();
  try {
    for (const [role, type] of [['ADMIN', 'admin'], ['CAMPUS_MANAGER', 'manager']]) {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        await page.setViewport({ width: 1440, height: 1000 });
        const account = Object.values(accounts.accounts).flat().find(row => row.role === role && (role === 'ADMIN' || row.campusId === campus));
        for (const limiter of [apiLimiter, loginLimiter]) for (const key of ['127.0.0.1', '::/56', '::ffff:127.0.0.1']) await limiter.resetKey(key);
        const login = await fetch(`http://localhost:5000${account.endpoint.split(' ')[1]}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [account.loginField]: account.login, password: account.password }),
        });
        assert.equal(login.status, 200); const session = (await login.json()).data;
        await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
        await page.evaluate((data, userType) => {
          localStorage.setItem('token', data.token); localStorage.setItem('user', JSON.stringify({ ...data.user, userType }));
          localStorage.setItem('userType', userType); localStorage.setItem('i18nextLng', 'en');
        }, session, type);
        const responseFor = (id, operation, method = 'PATCH') => page.waitForResponse(response =>
          new URL(response.url()).pathname === `/api/announcements/${id}${operation ? `/${operation}` : ''}` && response.request().method() === method);
        /** Find the current row after each consumer refetch and click its translated icon label. */
        const clickRow = async (title, action) => {
          const element = await page.waitForFunction((text, label) => {
            const titleNode = [...document.querySelectorAll('main p')].find(node => node.textContent === text);
            return titleNode?.closest('.MuiPaper-root')?.querySelector(`button[aria-label="${label}"]`);
          }, {}, title, action);
          await element.asElement().click(); await element.dispose();
        };
        const confirm = async () => {
          const button = await page.waitForFunction(label => [...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.trim() === label), {}, common.action.confirm);
          await button.asElement().click(); await button.dispose();
          await page.waitForSelector('[role="dialog"]', { hidden: true });
        };
        for (const theme of ['light', 'dark']) {
          const label = `Announcement audit: ${role} ${theme}`;
          try {
            const themed = await fetch('http://localhost:5000/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ theme }) });
            assert.equal(themed.status, 200);
            const title = `Audit browser ${type} ${theme}`;
            const doc = await Announcement.create({ schoolCampus: campus, title, content: 'Synthetic browser content' });
            await page.goto(`http://localhost:5173/campus/${campus}/notification`, { waitUntil: 'networkidle2' });
            await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, {}, theme);
            const published = responseFor(doc.id, 'publish'); await clickRow(title, labels.action.publish); await confirm(); assert.equal((await published).status(), 200);
            assert.equal(await AuditEvent.countDocuments({ entityId: doc._id }), 0);
            const archived = responseFor(doc.id, 'archive'); await clickRow(title, labels.action.archive); await confirm(); assert.equal((await archived).status(), 200);
            const rows = await AuditEvent.find({ entityId: doc._id }).lean(); assert.equal(rows.length, 1); assert.equal(rows[0].actor.role, role);
            assert.equal(String(rows[0].schoolCampus), campus); assert.equal((await Announcement.findById(doc._id).lean()).status, STATUS.ARCHIVED);
            record(`${label} publishes and archives atomically`, true);
            await clickRow(title, labels.action.edit);
            const input = await page.waitForSelector('[role="dialog"] [name="title"]', { visible: true });
            await input.click({ count: 3 }); await input.press('Backspace'); await input.type(`${title} edited`);
            const updated = responseFor(doc.id, '', 'PUT'); await page.click('[role="dialog"] button[type="submit"]'); assert.equal((await updated).status(), 200);
            await page.waitForSelector('[role="dialog"]', { hidden: true });
            const edit = await AuditEvent.findOne({ entityId: doc._id, 'changes.field': 'title' }).lean();
            assert.deepEqual(edit.changes, [{ field: 'title', mode: MODE.REDACTED }]);
            await page.waitForFunction(text => document.querySelector('main')?.innerText.includes(text), {}, `${title} edited`);
            await page.screenshot({ path: path.join(shots, `announcement-audit-${type}-${theme}.png`) });
            record(`${label} edits archived content with a redacted event`, true);
          } catch (error) { record(label, false, error.message); }
        }
      } finally { await context.close(); }
    }
  } finally {
    await Campus.updateOne({ _id: campus }, { $set: { entitlement: previous.entitlement } });
    require('../../shared/lib/entitlement').cache.clear();
  }
}

module.exports = { checkAnnouncementAudit };
