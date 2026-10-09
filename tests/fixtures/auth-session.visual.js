'use strict';
/** @file auth-session.visual.js
 * @description Real-browser login, HttpOnly refresh, reload and logout regressions.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');
const C = require('../../modules/account/session.constants');
const { assertTestDatabaseUri } = require('./seed.config');

/** Verify session lifecycle in two roles and both persisted themes, on disposable data. */
async function checkAuthSessions({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  const resetBudget = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1']
    .flatMap(key => [apiLimiter.resetKey(key), loginLimiter.resetKey(key)]));
  for (const role of ['ADMIN', 'CAMPUS_MANAGER']) {
    const actor = Object.values(accounts.accounts).flat().find(a => a.role === role);
    for (const theme of ['light', 'dark']) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      await page.setViewport({ width: 1440, height: 1000 });
      const label = `Authentication: ${role} / ${theme}`;
      try {
        await resetBudget();
        await page.goto(`http://localhost:5173${role === 'ADMIN' ? '/admin/login' : '/login'}`, { waitUntil: 'networkidle2' });
        if (role === 'CAMPUS_MANAGER') await page.click('[data-login-role="manager"]');
        await page.waitForSelector('#login-identifier', { visible: true });
        await page.type('#login-identifier', actor.login);
        await page.type('#login-password', actor.password);
        const loggedIn = page.waitForResponse(r => r.url().endsWith(actor.endpoint.split(' ')[1]) && r.request().method() === 'POST');
        await page.click('button[type="submit"]');
        assert.equal((await loggedIn).status(), 200);
        await page.waitForSelector('[aria-controls="profile-menu"]', { visible: true });
        const initial = await page.evaluate(() => localStorage.getItem('token'));
        const initialClaims = jwt.decode(initial);
        assert.equal(initialClaims.role, role);
        const storedCookie = (await context.cookies('http://localhost:5000/api/account/session/refresh'))
          .find(cookie => cookie.name === C.COOKIE);
        assert(storedCookie?.httpOnly, 'Refresh credential must be HttpOnly');
        assert(!(await page.evaluate(() => document.cookie)).includes(C.COOKIE));
        record(`${label}: login creates a protected refresh cookie`, true);

        const settings = await fetch('http://localhost:5000/api/settings', {
          method: 'PATCH', headers: { Authorization: `Bearer ${initial}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme }),
        });
        assert.equal(settings.status, 200);
        const { iat: _iat, exp: _exp, iss: _iss, ...claims } = initialClaims;
        const expired = jwt.sign(claims, process.env.JWT_SECRET, { issuer: C.ISSUER, expiresIn: -1 });
        let refreshCount = 0;
        const onResponse = r => { if (r.url().endsWith('/account/session/refresh') && r.request().method() === 'POST') refreshCount++; };
        page.on('response', onResponse);
        await page.evaluate(token => localStorage.setItem('token', token), expired);
        await page.reload({ waitUntil: 'networkidle2' });
        await page.waitForSelector('[aria-controls="profile-menu"]', { visible: true });
        const renewed = await page.evaluate(() => localStorage.getItem('token'));
        assert.equal(jwt.decode(renewed).sid, initialClaims.sid);
        assert(jwt.decode(renewed).exp > Date.now() / 1000);
        assert.equal(refreshCount, 1, 'Bootstrap must coalesce refresh');
        assert.equal(await page.evaluate(() => localStorage.getItem('erp_theme')), theme);
        const brightness = await page.evaluate(() => {
          const values = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number);
          return values ? (values[0] + values[1] + values[2]) / 3 : null;
        });
        assert(brightness !== null && (theme === 'dark' ? brightness < 90 : brightness > 190));
        await page.screenshot({ path: path.join(shots, `auth-${role.toLowerCase()}-${theme}.png`) });
        record(`${label}: expired access refreshes once on reload and preserves identity/theme`, true);

        await page.click('[aria-controls="profile-menu"]');
        const locale = await page.evaluate(() => JSON.parse(localStorage.getItem('user')).preferredLanguage || 'en');
        const common = JSON.parse(fs.readFileSync(path.join(dist, 'locales', locale, 'common.json')));
        const menu = await page.evaluateHandle(text => [...document.querySelectorAll('[role="menuitem"]')]
          .find(item => item.textContent.trim() === text), common.user.signOut);
        assert(menu.asElement(), 'Translated logout action must exist');
        const loggedOut = page.waitForResponse(r => r.url().endsWith('/account/session/logout') && r.request().method() === 'POST');
        await menu.asElement().click(); await menu.dispose();
        assert.equal((await loggedOut).status(), 200);
        await page.waitForFunction(() => location.pathname === '/login' && !localStorage.getItem('token'));
        const replay = await fetch('http://localhost:5000/api/account/session', { headers: { Authorization: `Bearer ${renewed}` } });
        assert.equal(replay.status, 401);
        assert(!(await context.cookies('http://localhost:5000/api/account/session/refresh')).some(c => c.name === C.COOKIE));
        record(`${label}: logout revokes the stolen access token and removes its cookie`, true);
      } catch (error) {
        record(label, false, error.message);
        await page.screenshot({ path: path.join(shots, `auth-failure-${role.toLowerCase()}-${theme}.png`) }).catch(() => {});
      } finally { await context.close(); }
    }
  }
}
module.exports = { checkAuthSessions };
