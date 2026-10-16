'use strict';
/* global document */
/** @file ai.visual.js
 * @description AI browser acceptance on real ERP routes and owned synthetic data.
 * The loopback S2S peer supplies deterministic provider responses; it is not a
 * Python/pgvector or provider-latency check. Document authorization uses its facade.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../../shared/configs/general.config');
const { FEATURE_STATES, FEATURE_ERROR_CODES } = require('../../shared/constants/features.constants');
const { AI_ERROR_CODES, AI_ANALYTICS_REPORTS, AI_ADVISORS } = require('../../shared/constants/ai.constants');
const { DOCUMENT_STATUS } = require('../../modules/document/models/document.model');
const { notDeletedFilter } = require('../../shared/utils/soft-delete');
const { apiLimiter, loginLimiter } = require('../../shared/middleware/rate-limiter');
const { assertTestDatabaseUri } = require('./seed.config');

/** Start a private fixture peer, retaining conversation ownership and signed scope. */
async function startPeer(accounts) {
  const secret = crypto.randomBytes(48).toString('hex');
  const requests = [];
  const conversations = new Map();
  const Document = mongoose.model('Document');
  const docs = new Map();
  for (const campus of Object.values(accounts.campuses)) {
    const doc = await Document.findOne({ campusId: campus.id, status: DOCUMENT_STATUS.PUBLISHED,
      ...notDeletedFilter(Document) }).lean();
    assert(doc, 'Nonempty published fixture corpus required');
    docs.set(campus.id, doc);
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const claims = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), secret,
        { algorithms: ['HS256'], issuer: 'erp-backend', audience: 'ai-service' });
      assert(claims.exp - claims.iat <= 300);
      assert(docs.has(claims.campusId));
      const url = new URL(req.url, 'http://localhost');
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const payload = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
      requests.push({ path: url.pathname, claims, payload });
      const owner = `${claims.campusId}:${claims.sub}`;
      const citation = (await require('../../modules/document').service.authorizeAiCitations(
        { userId: claims.sub, role: claims.role, campusId: claims.campusId },
        [String(docs.get(claims.campusId)._id)]
      ))[0];
      assert(citation, 'Fixture source must be currently authorized');
      if (url.pathname === '/usage') return json(200, { period: '2026-10', tokensIn: 100, tokensOut: 20 });
      if (url.pathname === '/chat') {
        const id = payload.conversationId || crypto.randomUUID();
        const existing = conversations.get(id);
        if (existing && existing.owner !== owner) return json(404, { detail: 'Conversation not found' });
        const content = `Synthetic answer for ${citation.label}`;
        const messages = [...(existing?.messages || []),
          { role: 'user', content: payload.message },
          { role: 'assistant', content, citations: [citation] }];
        conversations.set(id, { id, owner, messages, title: payload.message,
          updatedAt: '2026-10-09T10:00:00Z', messageCount: messages.length });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const [event, data] of [
          ['message_start', { conversationId: id }], ['delta', { text: content }],
          ['citations', { items: [citation] }], ['done', { profile: 'free', usage: { inputTokens: 100, outputTokens: 20 } }],
        ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return res.end();
      }
      if (url.pathname === '/conversations') {
        const items = [...conversations.values()].filter(c => c.owner === owner);
        return json(200, { items, total: items.length, page: 1, limit: 30 });
      }
      if (url.pathname.startsWith('/conversations/')) {
        const conv = conversations.get(url.pathname.split('/').pop());
        return conv?.owner === owner ? json(200, conv) : json(404, { detail: 'Conversation not found' });
      }
      if (url.pathname === '/search') return json(200, { results: [{ ...citation,
        title: citation.label, snippet: 'Synthetic authorized search result', score: 0.9 }] });
      if (url.pathname.startsWith('/analytics/')) {
        const figures = await require('../../modules/result').service.getCampusOverviewAggregates({ campusId: claims.campusId });
        return json(200, { figures, narrative: 'Synthetic summary of verified ERP figures',
          snapshotId: crypto.randomUUID(), generatedAt: '2026-10-09T10:00:00Z' });
      }
      if (url.pathname.startsWith('/advisors/')) return json(200, { proposals: [],
        engine: { modelVersion: 'fixture-only', outputs: {} } });
      return json(404, { detail: 'Unknown fixture route' });
    } catch (error) { return json(500, { detail: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, docs, secret, url: `http://127.0.0.1:${server.address().port}` };
}

/** Verify existing AI screens in both themes, with real sessions and feature gates. */
async function checkAiWorkspace({ browser, accounts, dist, shots, record }) {
  assertTestDatabaseUri(process.env.MONGODB_URI);
  assert.equal(process.env.NODE_ENV, 'test');
  const previous = { ...config.ai };
  const peer = await startPeer(accounts);
  config.ai.serviceUrl = peer.url; config.ai.serviceSecret = peer.secret;
  const A = accounts.campuses.A.id; const B = accounts.campuses.B.id;
  const reset = () => Promise.all(['127.0.0.1', '::/56', '::ffff:127.0.0.1']
    .flatMap(key => [apiLimiter.resetKey(key), loginLimiter.resetKey(key)]));
  const call = async (method, route, token, body) => {
    await reset();
    const response = await fetch(`http://localhost:5000/api/${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const adminActor = accounts.accounts.global.find(a => a.role === 'ADMIN');
  const login = await call('POST', 'admin/login', '', { email: adminActor.login, password: accounts.password });
  assert.equal(login.status, 200); const adminToken = login.body.data.token;
  const state = async (campus, value) => {
    const result = await call('PATCH', `admin/campuses/${campus}/entitlement`, adminToken,
      { plan: 'premium', ai: { llmProfile: 'free' }, modules: [{ key: 'ai', state: value,
        reason: 'Synthetic AI operational acceptance' }], reason: 'Synthetic AI operational acceptance' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  try {
    await state(A, FEATURE_STATES.ENABLED); await state(B, FEATURE_STATES.ENABLED);
    for (const role of ['ADMIN', 'CAMPUS_MANAGER']) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.createBrowserContext();
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        await page.setViewport({ width: 1440, height: 1000 });
        const actor = Object.values(accounts.accounts).flat().find(a => a.role === role && (!a.campusId || a.campusId === A));
        const route = role === 'ADMIN' ? '/admin/ai' : `/campus/${A}/ai`;
        const question = `Synthetic campus question ${role}/${theme}`;
        let catalog;
        const scenario = async (name, work) => {
          try { await work(); record(`AI: ${role}/${theme}: ${name}`, true); }
          catch (error) { record(`AI: ${role}/${theme}: ${name}`, false, error.message);
            await page.screenshot({ path: path.join(shots, `ai-failure-${role.toLowerCase()}-${theme}.png`) }).catch(() => {}); }
        };
        const button = async text => {
          const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')]
            .find(e => e.textContent.trim() === label), text);
          assert(handle.asElement(), `Missing button: ${text}`);
          await handle.asElement().click(); await handle.dispose();
        };
        const tab = async key => {
          await button(catalog.tabs[key]);
          await page.waitForFunction(label => [...document.querySelectorAll('[role="tab"]')]
            .some(e => e.getAttribute('aria-selected') === 'true' && e.textContent.trim() === label), {}, catalog.tabs[key]);
        };
        const goto = async () => { await reset(); await page.goto(`http://localhost:5173${route}`, { waitUntil: 'networkidle2' }); };
        try {
          await state(A, FEATURE_STATES.ENABLED); await reset();
          await page.goto(`http://localhost:5173${role === 'ADMIN' ? '/admin/login' : '/login'}`, { waitUntil: 'networkidle2' });
          if (role === 'CAMPUS_MANAGER') await page.click('[data-login-role="manager"]');
          await page.type('#login-identifier', actor.login); await page.type('#login-password', actor.password);
          const pending = page.waitForResponse(r => r.url().endsWith(actor.endpoint.split(' ')[1]) && r.request().method() === 'POST');
          await page.click('button[type="submit"]'); const response = await pending;
          assert.equal(response.status(), 200); const token = (await response.json()).data.token;
          await page.waitForSelector('[aria-controls="profile-menu"]');
          await call('PATCH', 'settings', token, { theme });
          await page.evaluate(campus => localStorage.setItem('ai_workspace_campus', campus), A);
          await goto();
          const locale = await page.evaluate(() => JSON.parse(localStorage.getItem('user')).preferredLanguage || 'en');
          catalog = JSON.parse(fs.readFileSync(path.join(dist, 'locales', locale, 'ai.json')));
          await scenario('renders usage, four tabs and persisted theme', async () => {
            assert.equal(await page.$$eval('[role="tab"]', es => es.length), 4);
            const text = await page.$eval('main', e => e.innerText);
            assert(text.includes(catalog.usage.title));
            assert(text.includes('120'), 'Displayed usage must include the supplied token count');
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
          });
          await scenario('SSE answer and signed campus identity', async () => {
            await page.type('textarea', question); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.body.innerText.includes('Synthetic answer for'));
            const request = peer.requests.filter(r => r.path === '/chat').at(-1);
            assert.equal(request.claims.sub, actor.id); assert.equal(request.claims.campusId, A);
            assert.equal(request.claims.role, role); assert.equal(request.claims.language, locale);
            assert(!('campusId' in request.payload));
            await page.screenshot({ path: path.join(shots, `ai-chat-${role.toLowerCase()}-${theme}.png`) });
          });
          await scenario('history loads the current conversation', async () => {
            await page.click(`button[aria-label="${catalog.chat.toggleHistory}"]`);
            await page.waitForSelector('main .MuiListItemButton-root');
            await button(catalog.chat.new);
            assert(!(await page.$eval('main', e => e.innerText)).includes('Synthetic answer for'));
            const detail = page.waitForResponse(r => r.request().method() === 'GET'
              && r.url().includes('/api/ai/conversations/'));
            assert(await page.evaluate(text => {
              const entry = [...document.querySelectorAll('main .MuiListItemButton-root')]
                .find(e => e.innerText.includes(text));
              entry?.click(); return !!entry;
            }, question), 'The current conversation must be present in history');
            const loaded = await detail;
            assert.equal(loaded.status(), 200);
            assert((await loaded.json()).data.messages.some(message => message.role === 'user'
              && message.content === question), 'History must load this scenario, not an earlier theme');
            await page.waitForFunction(() => document.body.innerText.includes('Synthetic answer for'));
          });
          await scenario('authorized search citation opens its real document drawer', async () => {
            await tab('search'); await page.type(`input[placeholder="${catalog.search.placeholder}"]`, 'Synthetic library query');
            await page.keyboard.press('Enter'); await page.waitForSelector('main a[target="_blank"]');
            const href = await page.$eval('main a[target="_blank"]', e => e.href);
            const target = await context.newPage();
            try { await target.goto(href, { waitUntil: 'networkidle2' });
              await target.waitForSelector('.MuiDrawer-paperAnchorRight', { visible: true });
              assert((await target.$eval('.MuiDrawer-paperAnchorRight', e => e.innerText)).includes(peer.docs.get(A).title));
              const errors = JSON.parse(fs.readFileSync(path.join(dist, 'locales', locale, 'errors.json')));
              await target.goto(`http://localhost:5173/campus/${A}/documents?documentId=${peer.docs.get(B)._id}`, { waitUntil: 'networkidle2' });
              await target.waitForFunction(text => document.body.innerText.includes(text), {}, errors.api.notFound);
              assert.equal(await target.$('.MuiDrawer-paperAnchorRight'), null, 'A citation from another campus cannot open in this workspace');
            } finally { await target.close(); }
          });
          await scenario('analytics renders ERP figures and advisors render zero proposals', async () => {
            await tab('analytics'); const result = page.waitForResponse(r => r.request().method() === 'POST'
              && r.url().includes(`/analytics/${AI_ANALYTICS_REPORTS.CLASS_PERFORMANCE}`));
            await button(catalog.analytics.run); const response = await result;
            assert.equal(response.status(), 200);
            const expected = await require('../../modules/result').service.getCampusOverviewAggregates({ campusId: A });
            const figures = (await response.json()).data.figures;
            assert.deepEqual(figures, expected);
            assert(Object.values(expected).some(value => typeof value === 'number' && value > 0), 'Fixture aggregates must contain a nonzero figure');
            await page.waitForFunction(() => document.body.innerText.includes('Synthetic summary of verified ERP figures'));
            const displayed = await page.$$eval('main .MuiTypography-h6', es => es.map(e => e.innerText));
            for (const value of Object.values(expected).filter(value => typeof value === 'number')) {
              assert(displayed.includes(value.toLocaleString()), `Missing ERP figure: ${value}`);
            }
            await page.screenshot({ path: path.join(shots, `ai-analytics-${role.toLowerCase()}-${theme}.png`) });
            await tab('advisors'); const proposals = page.waitForResponse(r => r.request().method() === 'POST'
              && r.url().includes(`/advisors/${AI_ADVISORS.FINANCE}`));
            await button(catalog.advisors.run); assert.equal((await proposals).status(), 200);
            await page.waitForFunction(text => document.body.innerText.includes(text), {}, catalog.advisors.noProposalsTitle);
          });
          if (role === 'CAMPUS_MANAGER') {
            await scenario('read-only keeps history and disables every generation control', async () => {
              await state(A, FEATURE_STATES.READ_ONLY); await goto();
              assert(await page.$eval('textarea', e => e.disabled));
              await page.click(`button[aria-label="${catalog.chat.toggleHistory}"]`);
              await page.waitForSelector('main .MuiListItemButton-root');
              await page.click('main .MuiListItemButton-root');
              await page.waitForFunction(() => document.body.innerText.includes('Synthetic answer for'));
              for (const key of ['search', 'analytics', 'advisors']) {
                await tab(key);
                if (key === 'search') {
                  assert(await page.$eval('main input[placeholder]', e => e.disabled));
                } else {
                  const label = key === 'analytics' ? catalog.analytics.run : catalog.advisors.run;
                  assert(await page.evaluate(text => [...document.querySelectorAll('main button')]
                    .some(e => e.textContent.trim() === text && e.disabled), label));
                }
              }
              const denied = await call('POST', 'ai/chat', token, { message: 'Must be refused' });
              assert.equal(denied.status, 403); assert.equal(denied.body.errors?.code, FEATURE_ERROR_CODES.FEATURE_READ_ONLY);
              await page.screenshot({ path: path.join(shots, `ai-read-only-${theme}.png`) });
            });
            await scenario('hidden blocks direct navigation and API without reaching the peer', async () => {
              await state(A, FEATURE_STATES.HIDDEN); const count = peer.requests.length; await goto();
              assert.equal(await page.$('textarea'), null);
              assert.equal(await page.$$eval('[role="tab"]', es => es.length), 0);
              const denied = await call('GET', 'ai/conversations', token);
              assert.equal(denied.status, 403); assert.equal(denied.body.errors?.code, FEATURE_ERROR_CODES.FEATURE_DISABLED);
              assert.equal(peer.requests.length, count);
              await page.screenshot({ path: path.join(shots, `ai-hidden-${theme}.png`) });
            });
          }
          await scenario('disabled service degrades with translated notice', async () => {
            await state(A, FEATURE_STATES.ENABLED); config.ai.serviceUrl = ''; await goto();
            await page.waitForFunction(text => document.body.innerText.includes(text), {}, catalog.errors[AI_ERROR_CODES.AI_DISABLED].title);
            assert.equal(await page.$('textarea'), null);
            await page.screenshot({ path: path.join(shots, `ai-disabled-${role.toLowerCase()}-${theme}.png`) });
            config.ai.serviceUrl = peer.url;
          });
        } finally { config.ai.serviceUrl = peer.url; await context.close(); }
      }
    }
  } finally {
    Object.assign(config.ai, previous);
    await new Promise(resolve => peer.server.close(resolve));
  }
}
module.exports = { checkAiWorkspace };
