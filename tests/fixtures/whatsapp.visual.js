'use strict';
/* global document */
/** @file whatsapp.visual.js @description Shared consent and delivery-history browser acceptance on synthetic data. */
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const mongoose = require('mongoose');
const { assertTestDatabaseUri } = require('./seed.config');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');
/** Exercise the production SPA, real authentication and persistence in both themes. */
async function checkWhatsapp({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  await require('../../scripts/prepare-whatsapp').prepareWhatsapp({ apply: true });
  const service = require('../../modules/notification').service;
  const Campus = mongoose.model('Campus');
  const resetBudget = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1'].flatMap(key => [apiLimiter.resetKey(key), loginLimiter.resetKey(key)]));
  for (const role of ['ADMIN', 'CAMPUS_MANAGER']) {
    const actor = Object.values(accounts.accounts).flat().find(row => row.role === role);
    for (const theme of ['light', 'dark']) {
      const context = await browser.createBrowserContext(); const page = await context.newPage();
      page.setDefaultTimeout(20000); await page.setViewport({ width: 1440, height: 1000 });
      const label = `WhatsApp: ${role} / ${theme}`;
      try {
        await resetBudget();
        await page.goto(`http://localhost:5173${role === 'ADMIN' ? '/admin/login' : '/login'}`, { waitUntil: 'networkidle2' });
        if (role === 'CAMPUS_MANAGER') await page.click('[data-login-role="manager"]');
        await page.waitForSelector('#login-identifier', { visible: true });
        await page.type('#login-identifier', actor.login); await page.type('#login-password', actor.password);
        const logged = page.waitForResponse(response => response.url().endsWith(actor.endpoint.split(' ')[1]) && response.request().method() === 'POST');
        await page.click('button[type="submit"]'); assert.equal((await logged).status(), 200);
        await page.waitForSelector('[aria-controls="profile-menu"]', { visible: true });
        const token = await page.evaluate(() => localStorage.getItem('token'));
        const settings = await fetch('http://localhost:5000/api/settings', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
        assert.equal(settings.status, 200);
        await page.reload({ waitUntil: 'networkidle2' });
        const locale = await page.evaluate(() => localStorage.getItem('i18nextLng') || document.documentElement.lang || 'fr');
        const base = locale.split('-')[0];
        const language = fs.existsSync(path.join(dist, 'locales', locale, 'notifications.json')) ? locale : base;
        const text = JSON.parse(fs.readFileSync(path.join(dist, 'locales', language, 'notifications.json'), 'utf8')).whatsapp;
        const open = async () => {
          // The form unmounts before MUI's closing backdrop stops intercepting clicks.
          await page.waitForFunction(() => !document.querySelector('.MuiDialog-root'));
          await page.click('[aria-controls="profile-menu"]'); await page.waitForSelector('[data-whatsapp-consent]', { visible: true }); await page.click('[data-whatsapp-consent]');
          await page.waitForSelector('[data-whatsapp-form] input[name="enabled"]', { visible: true });
          await page.waitForFunction(() => {
            const dialog = document.querySelector('.MuiDialog-container');
            return dialog && document.defaultView.getComputedStyle(dialog).opacity === '1'
              && dialog.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running');
          });
        };
        await open();
        const body = await page.$eval('[data-whatsapp-form]', node => node.textContent);
        assert(body.includes(text.scope) && body.includes(text.withdrawal));
        record(`${label}: localized explicit scope and withdrawal are visible`, true);
        const checkbox = '[data-whatsapp-form] input[name="enabled"]';
        if (!await page.$eval(checkbox, node => node.checked)) await page.click(checkbox);
        const field = '[data-whatsapp-form] input[name="phone"]';
        await page.click(field, { clickCount: 3 }); await page.type(field, '600000001'); await page.click('[data-whatsapp-form] button[type="submit"]');
        await page.waitForFunction(expected => document.querySelector('[data-whatsapp-form]')?.textContent.includes(expected), {}, text.invalidPhone);
        record(`${label}: local-only phone is rejected before consent grant`, true);
        await page.click(field, { clickCount: 3 }); await page.type(field, '+237600000001');
        const saved = page.waitForResponse(response => response.url().endsWith('/notifications/my/whatsapp-consent') && response.request().method() === 'PUT');
        await page.click('[data-whatsapp-form] button[type="submit"]'); assert.equal((await saved).status(), 200);
        await page.waitForFunction(() => !document.querySelector('[data-whatsapp-form]'));
        await open(); assert(await page.$eval(checkbox, node => node.checked));
        assert.equal(await page.$eval(field, node => node.value), '+237600000001');
        await page.screenshot({ path: path.join(shots, `whatsapp-consent-${role.toLowerCase()}-${theme}.png`) });
        record(`${label}: consent persists and reloads without granting another identity`, true);
        await page.click(checkbox);
        const withdrawn = page.waitForResponse(response => response.url().endsWith('/notifications/my/whatsapp-consent') && response.request().method() === 'PUT');
        await page.click('[data-whatsapp-form] button[type="submit"]'); assert.equal((await withdrawn).status(), 200);
        const own = await fetch('http://localhost:5000/api/notifications/my/whatsapp-consent', { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json());
        assert.equal(own.data.enabled, false); assert(own.data.revokedAt);
        record(`${label}: withdrawal is stored with evidence`, true);
        if (role === 'CAMPUS_MANAGER') {
          const stored = await Campus.findById(actor.campusId).select('entitlement').lean();
          try {
            for (const state of ['enabled', 'read_only', 'hidden']) {
              await Campus.updateOne({ _id: actor.campusId }, { $set: { 'entitlement.modules': [{ key: 'result', state, setBy: 'admin' }] } });
              require('../../shared/lib/entitlement').cache.clear();
              const rows = await service.notify({ recipient: { id: actor.id, model: 'Campus', campusId: actor.campusId, phone: '+237600000001' }, channels: ['inapp', 'whatsapp'], template: 'result.published', locale: 'fr' });
              assert(state === 'enabled' ? rows.length === 2 && rows[1].status === 'skipped' : rows.length === 0);
              await page.goto(`http://localhost:5173/campus/${actor.campusId}/notification-log`, { waitUntil: 'networkidle2' });
              await page.waitForSelector('[data-whatsapp-usage]', { visible: true });
              const log = await page.evaluate(() => document.body.textContent);
              assert(!log.includes('whatsapp.usage') && !log.includes('WHATSAPP_CONSENT_REQUIRED'));
              record(`${label}: ${state} emission policy preserves readable history and campus quota`, true);
            }
            await page.screenshot({ path: path.join(shots, `whatsapp-log-manager-${theme}.png`) });
          } finally {
            await Campus.updateOne({ _id: actor.campusId }, { $set: { 'entitlement.modules': stored.entitlement?.modules || [] } });
            require('../../shared/lib/entitlement').cache.clear();
          }
        }
      } catch (error) {
        record(label, false, error.message);
        await page.screenshot({ path: path.join(shots, `whatsapp-failure-${role.toLowerCase()}-${theme}.png`) }).catch(() => {});
      } finally { await context.close(); }
    }
  }
}
module.exports = { checkWhatsapp };
