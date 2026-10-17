/**
 * @file portal-browser.js
 * @description Built public-portal smoke QA with owned loopback servers and synthetic data.
 * No database or provider. Reuses backend Chrome tooling; not the later CH-4 project.
 * Build the separate portal first, then npm run test:portal -- /tmp/portal-shots.
 * PORTAL_ROOT can select an isolated built checkout. Server keys are generated per run.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  spawn
} = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const {
  FEATURE_ERROR_CODES
} = require('../../shared/constants/features.constants');
if (process.env.NODE_ENV === 'production') throw new Error('Portal QA refuses production mode.');
const root = path.resolve(process.env.PORTAL_ROOT || path.resolve(__dirname, '../../../../partner'));
if (!fs.existsSync(path.join(root, '.next/BUILD_ID'))) throw new Error('Build the portal before browser QA; set PORTAL_ROOT for an isolated build.');
const shots = path.resolve(process.argv[2] || path.join(__dirname, '../fixtures/.generated/portal-visual'));
fs.mkdirSync(shots, {
  recursive: true
});
const portalKey = require('node:crypto').randomBytes(32).toString('hex');
const received = [];
let child, browser;
let checks = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  checks++;
  console.log('PASS ' + label);
};
const missing = {
  success: false,
  message: 'Campus not found'
};
const erp = http.createServer(async (req, res) => {
  if (req.headers['x-portal-key'] !== portalKey) {
    res.writeHead(401);
    res.end(JSON.stringify({
      success: false
    }));
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  let status = 200,
    data = {};
  if (url.pathname === '/api/public/campus-info') {
    const ref = url.searchParams.get('ref');
    const slug = url.searchParams.get('slug') || 'test-campus';
    if (slug === 'hidden' || slug === 'missing') {
      res.writeHead(404, {
        'content-type': 'application/json'
      });
      res.end(JSON.stringify(missing));
      return;
    }
    data = {
      campusSlug: ref === 'READONLY' ? 'readonly' : 'test-campus',
      campusName: 'Synthetic Campus',
      logoUrl: null,
      programs: ['Test Program'],
      lang: 'en',
      ...(ref ? {
        partnerCode: ref
      } : {})
    };
  } else if (url.pathname === '/api/public/campuses') data = {
    campuses: [{
      campusSlug: 'test-campus',
      campusName: 'Synthetic Campus'
    }]
  };else if (url.pathname === '/api/public/programs') data = {
    campusName: 'Synthetic Campus',
    programs: ['Test Program']
  };else if (url.pathname === '/api/public/pre-register') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push(body);
    if (body.partnerCode === 'READONLY') {
      res.writeHead(403, {
        'content-type': 'application/json'
      });
      res.end(JSON.stringify({
        success: false,
        message: 'Closed',
        errors: {
          code: FEATURE_ERROR_CODES.FEATURE_READ_ONLY
        }
      }));
      return;
    }
    if (['hidden', 'missing'].includes(body.campusSlug)) {
      res.writeHead(404, {
        'content-type': 'application/json'
      });
      res.end(JSON.stringify(missing));
      return;
    }
    status = 202;
  }
  res.writeHead(status, {
    'content-type': 'application/json'
  });
  res.end(JSON.stringify({
    success: true,
    data
  }));
});
const pause = ms => new Promise(r => setTimeout(r, ms));
/** Open one page and refuse any browser traffic outside the owned portal. */
async function openPage(context, origin) {
  const page = await context.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().startsWith(origin + '/') || req.url().startsWith('data:')) req.continue();else req.abort();
  });
  return page;
}
(async () => {
  try {
    await new Promise(r => erp.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${erp.address().port}`;
    const probe = http.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    const origin = `http://127.0.0.1:${port}`;
    const log = fs.openSync(path.join(shots, 'server.log'), 'w');
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        ERP_API_URL: api,
        PORTAL_API_KEY: portalKey,
        DEFAULT_CAMPUS_SLUG: 'test-campus',
        NEXT_PUBLIC_PORTAL_URL: origin
      },
      stdio: ['ignore', log, log]
    });
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error('Next exited before readiness');
      try {
        const r = await fetch(origin + '/en?slug=test-campus');
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await pause(500);
    }
    assert.ok(ready, 'Next readiness');
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const locales = fs.readdirSync(path.join(root, 'src/messages')).filter(name => name.endsWith('.json')).map(name => path.basename(name, '.json'));
    for (const locale of locales) {
      const ctx = await browser.createBrowserContext();
      const page = await openPage(ctx, origin);
      await page.setViewport({
        width: 1280,
        height: 900
      });
      const response = await page.goto(`${origin}/${locale}?slug=test-campus`, {
        waitUntil: 'networkidle0'
      });
      check('render locale ' + locale, response.status() === 200 && (await page.$eval('html', el => el.lang)) === locale);
      if (locale === 'ar') {
        check('Arabic RTL', (await page.$eval('html', el => el.dir)) === 'rtl');
        await page.screenshot({
          path: path.join(shots, 'arabic.png')
        });
      }
      await ctx.close();
    }
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.createBrowserContext();
      const page = await openPage(ctx, origin);
      await page.setViewport({
        width: 1280,
        height: 1000
      });
      await page.emulateMediaFeatures([{
        name: 'prefers-color-scheme',
        value: scheme
      }]);
      await page.goto(origin + '/fr?slug=test-campus', {
        waitUntil: 'networkidle0'
      });
      check('light portal under ' + scheme + ' OS preference', (await page.$eval('body', el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor)) === 'rgb(255, 255, 255)');
      await (await page.$('form')).screenshot({
        path: path.join(shots, 'form-' + scheme + '.png')
      });
      await ctx.close();
    }
    for (const ref of ['TESTREF', 'READONLY']) {
      const ctx = await browser.createBrowserContext();
      const page = await openPage(ctx, origin);
      const messages = JSON.parse(fs.readFileSync(path.join(root, 'src/messages/en.json'))).register;
      let leaked = false;
      page.on('request', r => {
        if (JSON.stringify(r.headers()).includes(portalKey)) leaked = true;
      });
      await page.goto(origin + `/en?ref=${ref}&src=qr&utm_source=smoke`, {
        waitUntil: 'networkidle0'
      });
      for (const [name, value] of Object.entries({
        firstName: 'Test',
        lastName: 'Applicant',
        email: 'smoke@example.test'
      })) await page.type(`[name="${name}"]`, value);
      const wait = page.waitForResponse(r => r.url().endsWith('/api/pre-register') && r.request().method() === 'POST');
      await page.click('button[type="submit"]');
      const response = await wait;
      const target = ref === 'TESTREF' ? messages.success_title : messages.error_intake_closed;
      await page.waitForFunction(text => globalThis.document.body.innerText.includes(text), {}, target);
      check('rendered ' + ref + ' submission', response.status() === (ref === 'TESTREF' ? 202 : 403));
      check('server key absent from browser ' + ref, !leaked);
      if (ref === 'TESTREF') check('referral and UTM reach server', received.at(-1).partnerCode === ref && received.at(-1).source === 'qr_code' && received.at(-1).utmParams.utm_source === 'smoke' && !received.at(-1).campusSlug);
      await page.screenshot({
        path: path.join(shots, ref.toLowerCase() + '.png')
      });
      await ctx.close();
    }
    const bodies = [];
    for (const campusSlug of ['hidden', 'missing']) {
      const response = await fetch(origin + '/api/pre-register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          campusSlug
        })
      });
      assert.equal(response.status, 404);
      bodies.push(await response.text());
    }
    check('hidden and missing refusals are identical', bodies[0] === bodies[1]);
    const image = await fetch(origin + '/_next/image?url=%2Ficon-192.png&w=256&q=75', {
      headers: {
        accept: 'image/avif'
      }
    });
    check('patched Sharp performs real image optimization', image.status === 200 && image.headers.get('content-type')?.startsWith('image/') && (await image.arrayBuffer()).byteLength > 0);
    console.log(`RESULT ${checks}/${checks} PASS`);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(r => child.once('exit', r));
    }
    await new Promise(r => erp.close(r));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
