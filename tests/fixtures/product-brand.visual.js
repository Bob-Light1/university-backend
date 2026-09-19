'use strict';
/* global document, getComputedStyle */

/**
 * @file product-brand.visual.js
 * @description Opt-in deployment-brand browser check against a local Vite instance.
 * Start the frontend with VITE_BRAND_NAME="Atlas Education",
 * VITE_BRAND_LOGO_URL=/missing-brand.svg and VITE_SALES_URL=https://example.test/demo
 * on port 5174, then run this file. No form submission or external message is sent.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer-core');

/** Verify the real public, login and activation renderings with a missing custom logo. */
async function main() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: true, pipe: true, timeout: 90000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const response = await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle2', timeout: 90000 });
    assert((await response.text()).includes('<title>Atlas Education'), 'initial HTML uses deployment brand');
    await page.waitForSelector('[data-testid="product-home"]');
    const rendered = await page.evaluate(() => ({
      title: document.title,
      brand: document.querySelector('.product-brand').textContent,
      fallback: !document.querySelector('.product-brand img'),
      sales: document.querySelector('[data-testid="home-primary"]').getAttribute('href'),
      background: getComputedStyle(document.querySelector('main')).backgroundColor,
    }));
    assert(rendered.title.includes('Atlas Education'));
    assert(rendered.brand.includes('Atlas Education'));
    assert(rendered.fallback, 'missing custom logo falls back to the neutral symbol');
    assert.equal(rendered.sales, 'https://example.test/demo');
    assert.equal(rendered.background, 'rgb(255, 255, 255)');
    console.log('PASS custom home identity, logo fallback, commercial URL and initial metadata');
    await page.goto('http://127.0.0.1:5174/login', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('main').innerText.includes('Atlas Education'));
    assert(!(await page.$eval('main', element => element.innerText)).includes('wewigo'));
    console.log('PASS custom login identity');
    await page.goto('http://127.0.0.1:5174/activate', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.body.innerText.includes('Atlas Education'));
    console.log('PASS custom activation identity');
  } finally { await browser.close(); }

  // Compile the actual portal resolver; there is no parallel reimplementation.
  const portal = path.resolve(__dirname, '../../../../partner');
  const ts = require(path.join(portal, 'node_modules/typescript'));
  const source = fs.readFileSync(path.join(portal, 'src/lib/brand.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const resolve = env => {
    const exports = {};
    vm.runInNewContext(compiled, { exports, URL, process: { env } });
    return exports;
  };
  assert.equal(resolve({}).BRAND_NAME, 'Wewigo');
  const custom = resolve({ NEXT_PUBLIC_PRODUCT_BRAND_NAME: 'Atlas Education', NEXT_PUBLIC_PRODUCT_BRAND_LOGO_URL: '/atlas.svg' });
  assert.equal(custom.BRAND_NAME, 'Atlas Education');
  assert.equal(custom.BRAND_LOGO, '/atlas.svg');
  const institution = resolve({ NEXT_PUBLIC_PRODUCT_BRAND_NAME: 'Atlas Education', NEXT_PUBLIC_BRAND_NAME: 'Example Campus', NEXT_PUBLIC_PRODUCT_BRAND_LOGO_URL: '/atlas.svg' });
  assert.equal(institution.BRAND_NAME, 'Example Campus');
  assert.equal(institution.BRAND_LOGO, '');
  console.log('PASS portal default, product fallback and establishment override');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
