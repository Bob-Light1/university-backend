'use strict';

/** @file pdf-protocol.test.js @description Real PDF engines must explicitly use CDP and never load the unused Zod/BiDi parser. */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('both PDF engines use CDP without loading Zod or the BiDi mapper', async () => {
  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || await require('@sparticuz/chromium').executablePath();
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) {
      assert.ok(!['zod', 'chromium-bidi'].includes(id.split('/')[0]), 'Unused BiDi dependency loaded: ' + id);
      return load.call(this, id, ...args);
    };
    const puppeteer = require('puppeteer-core');
    const launch = puppeteer.launch.bind(puppeteer);
    let launches = 0;
    puppeteer.launch = async options => {
      assert.equal(options.protocol, 'cdp');
      launches++;
      return launch(options);
    };
    const ged = require('./modules/document/services/document.pdf.service');
    const academic = require('./modules/academic-print/academic-pdf.service');
    (async () => {
      try {
        await ged.initPool();
        const pdf = await academic.renderPdf('<html><body>Synthetic CDP verification</body></html>');
        assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
        assert.equal(launches, 2);
        console.log('CDP engines and real PDF verified');
      } finally {
        await Promise.all([ged.shutdownPool(), academic.shutdownAcademicPool()]);
        await require('mongoose').disconnect();
      }
    })().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  `;
  const result = await run(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../..'),
    env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: chromePath, PUPPETEER_POOL_SIZE: '1' },
    timeout: 90000,
  });
  expect(result.stdout).toContain('CDP engines and real PDF verified');
}, 95000);
