'use strict';

/**
 * @file dev-watch.test.js
 * @description Real development watcher: imported-file changes restart the
 * application and let its SIGTERM shutdown handler run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { scripts } = require('../../package.json');

test('development mode restarts on an imported-file change and sends SIGTERM', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-dev-watch-'));
  const entry = path.join(directory, 'server.cjs');
  const dependency = path.join(directory, 'value.cjs');
  fs.writeFileSync(dependency, "module.exports = 'initial';\n");
  fs.writeFileSync(entry, `
    console.log('START:' + require('./value.cjs'));
    process.on('SIGTERM', () => { console.log('STOP:SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  const args = scripts.dev.split(/\s+/).slice(1).map(arg => arg === 'server.js' ? entry : arg);
  const child = spawn(process.execPath, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const waitFor = async text => {
    const deadline = Date.now() + 10000;
    while (!output.includes(text) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(output).toContain(text);
  };
  try {
    await waitFor('START:initial');
    fs.writeFileSync(dependency, "module.exports = 'updated';\n");
    await waitFor('START:updated');
    expect(output).toContain('STOP:SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
