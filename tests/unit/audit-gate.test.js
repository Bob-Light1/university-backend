'use strict';

/**
 * @file audit-gate.test.js
 * @description Named archive exceptions must not hide other advisories or outlive them.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/audit-gate.js'), 'utf8');
const archiveIds = ['GHSA-jmr9-qjv8-65gv', 'GHSA-7pqw-9j4j-h8q3'];

/** Build an npm advisory response without invoking the registry. */
function finding(name, ids) {
  return {
    severity: 'high',
    via: ids.map((id) => ({ name, title: id, severity: 'high', url: `https://github.com/advisories/${id}` })),
  };
}

/** Execute the real CLI with only its audit subprocess and output replaced. */
function runGate(vulnerabilities) {
  const output = [];
  const exitSignal = new Error('audit exit');
  let exitCode = 0;
  const execFileSync = jest.fn(() => {
    // npm audit returns nonzero even when the only findings are accepted.
    const error = new Error('npm audit found vulnerabilities');
    error.stdout = JSON.stringify({ vulnerabilities });
    throw error;
  });
  try {
    vm.runInNewContext(source, {
      require: (name) => {
        if (name !== 'node:child_process') throw new Error(`Unexpected dependency: ${name}`);
        return { execFileSync };
      },
      console: {
        log: (...args) => output.push(args.join(' ')),
        error: (...args) => output.push(args.join(' ')),
      },
      process: { exit: (code) => { exitCode = code; throw exitSignal; } },
    });
  } catch (error) {
    if (error !== exitSignal) throw error;
  }
  expect(execFileSync).toHaveBeenCalledWith('npm', ['audit', '--json'], expect.any(Object));
  return { exitCode, output: output.join('\n') };
}

test('both documented archive advisories are accepted by their exact IDs', () => {
  expect(runGate({ 'extract-zip': finding('extract-zip', archiveIds) }).exitCode).toBe(0);
});

test.each(['sharp', 'extract-zip'])('an additional advisory for %s still blocks CI', (name) => {
  const report = { 'extract-zip': finding('extract-zip', archiveIds) };
  const id = name === 'sharp' ? 'GHSA-rgj7-g3m4-5g8c' : 'GHSA-test-new1-new2';
  if (name === 'extract-zip') report[name].via.push(...finding(name, [id]).via);
  else report[name] = finding(name, [id]);
  const result = runGate(report);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`BLOCKING  ${id}`);
});

test.each(archiveIds)('a resolved exception %s must be removed', (removedId) => {
  const result = runGate({ 'extract-zip': finding('extract-zip', archiveIds.filter((id) => id !== removedId)) });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`STALE     ${removedId}`);
});
