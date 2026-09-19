'use strict';
/* global document, getComputedStyle, innerWidth, location */

/**
 * @file product-home.visual.js
 * @description Public product checks plugged into the existing browser harness.
 * Uses synthetic presentation data and performs no enrollment or external contact.
 */
const fs = require('fs');
const path = require('path');

/** Verify public behavior using the catalogs served by the current build. */
async function checkProductHome({ browser, baseUrl, dist, shots, record }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url().split('?')[0]); });
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluateOnNewDocument(() => { localStorage.setItem('erp_language', 'en'); localStorage.setItem('erp_theme', 'dark'); });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('[data-testid="product-home"]');
    const en = JSON.parse(fs.readFileSync(path.join(dist, 'locales/en/home.json')));
    record('home: product positioning and single footer', await page.evaluate(title => document.querySelectorAll('footer').length === 1 && document.querySelector('h1').textContent.includes(title), en.heroTitle));
    record('home: remains light with dark workspace preference', await page.$eval('.product-home', element => getComputedStyle(element).backgroundColor === 'rgb(255, 255, 255)'));
    await page.click('[data-testid="preview-tab-finance"]');
    record('home: finance preview shows the configured illustration', await page.$eval('[data-testid="preview-panel"]', (element, title) => element.textContent.includes(title), en.previewTitles.finance));
    await page.focus('[data-testid="preview-tab-finance"]');
    await page.keyboard.press('Home');
    record('home: tabs support keyboard Home', await page.$eval('[data-testid="preview-tab-overview"]', element => element.getAttribute('aria-selected') === 'true' && document.activeElement === element));
    const locales = fs.readdirSync(path.join(dist, 'locales')).filter(locale => fs.existsSync(path.join(dist, 'locales', locale, 'home.json')));
    for (const locale of locales) {
      // The public selector is available in the desktop navigation.
      await page.setViewport({ width: 1440, height: 1000 });
      await page.select('[data-testid="home-language"]', locale);
      await page.waitForFunction(lang => document.documentElement.lang === lang, {}, locale);
      const catalog = JSON.parse(fs.readFileSync(path.join(dist, 'locales', locale, 'home.json')));
      record(`home: ${locale} translated title`, await page.$eval('h1', (element, title) => element.textContent.includes(title), catalog.heroTitle));
      if (['en', 'fr', 'ar'].includes(locale)) {
        for (const width of [360, 390, 768, 1440]) {
          await page.setViewport({ width, height: 1000 });
          record(`home: ${locale} ${width}px no overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
      }
    }
    await page.select('[data-testid="home-language"]', 'fr');
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    record('home: anonymous locale persists locally', await page.evaluate(() => localStorage.getItem('erp_language') === 'fr' && document.cookie.includes('erp_lang=fr')));
    await page.screenshot({ path: path.join(shots, 'product-home-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await page.click('[data-testid="home-menu"]');
    record('home: mobile menu opens', await page.$eval('[data-testid="home-menu"]', element => element.getAttribute('aria-expanded') === 'true'));
    await page.keyboard.press('Escape');
    record('home: Escape closes menu and restores focus', await page.$eval('[data-testid="home-menu"]', element => element.getAttribute('aria-expanded') === 'false' && document.activeElement === element));
    await page.screenshot({ path: path.join(shots, 'product-home-mobile.png'), fullPage: true });
    record('home: enrollment stays in the separate portal', await page.$eval('[data-testid="home-enrollment"]', element => new URL(element.href).origin !== location.origin));
    record('home: no business/settings API requests', requests.length === 0, requests.join(', '));
    record('home: no browser exceptions', errors.length === 0, errors.join(', '));
  } finally { await context.close(); }
}

module.exports = { checkProductHome };
