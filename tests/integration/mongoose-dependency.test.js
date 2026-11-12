'use strict';

/**
 * @file mongoose-dependency.test.js
 * @description Real Mongoose regressions for the 8.24.7 security patch.
 * Potentially polluting inputs run in separate processes, never in Jest's process.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Runs actual Mongoose code in an isolated process without a database connection.
 *
 * @param {string} body
 * @returns {void}
 */
const verifyInChild = (body) => {
  const code = `
    const assert = require('node:assert/strict');
    const mongoose = require('mongoose');
    Promise.resolve().then(async () => {
      ${body}
    }).catch((error) => {
      console.error(error.stack);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
};

test('connection sanitizeFilter rejects selector objects before the driver', () => {
  verifyInChild(`
    const connection = mongoose.createConnection();
    // Native connection setup stores this option in config, not options.
    connection.config.sanitizeFilter = true;
    assert.equal(connection.get('sanitizeFilter'), true);
    const Probe = connection.model('SanitizeProbe', new mongoose.Schema({ value: String }));
    let reached = false;
    Probe.collection.findOne = async () => { reached = true; return null; };
    await assert.rejects(Probe.findOne({ value: { $ne: null } }).exec(), mongoose.Error.CastError);
    assert.equal(reached, false);
    await Probe.findOne({ value: 'synthetic literal' });
    assert.equal(reached, true);
  `);
});

test('inherited discriminator names preserve casting and strict field filtering', () => {
  verifyInChild(`
    const Base = mongoose.model('DiscriminatorProbe', new mongoose.Schema({ value: Number }, { discriminatorKey: 'kind' }));
    const Child = Base.discriminator('Child', new mongoose.Schema({ detail: String }));
    const record = new Base({ kind: 'constructor', value: '42', unlisted: true });
    assert(record instanceof Base);
    assert.equal(record.value, 42);
    assert.equal(record.get('unlisted'), undefined);
    const child = new Base({ kind: 'Child', value: '7', detail: 'synthetic' });
    assert(child instanceof Child);
    assert.equal(child.value, 7);
  `);
});

test.each([
  ['hydration', `
    const Probe = mongoose.model('HydrationProbe', new mongoose.Schema({ name: String }, { strict: false }));
    const record = Probe.hydrate({ name: 'synthetic', toString: { auditRetentionProbe: true } });
    assert.equal(record.name, 'synthetic');
  `],
  ['dotted Mixed assignment', `
    const Probe = mongoose.model('AssignmentProbe', new mongoose.Schema({ metadata: {} }));
    const record = new Probe({ 'metadata.toString.auditRetentionProbe': true });
    assert(record instanceof Probe);
  `],
  ['replacement merging', `
    const Probe = mongoose.model('MergeProbe', new mongoose.Schema({ name: String }));
    const query = Probe.findOneAndReplace({}, { name: 'synthetic', toString: { auditRetentionProbe: true } });
    assert.equal(query.getUpdate().name, 'synthetic');
  `],
])('%s does not write through inherited built-in functions', (_label, action) => {
  verifyInChild(`
    ${action}
    assert.equal(Object.hasOwn(Object.prototype.toString, 'auditRetentionProbe'), false);
    assert.equal(typeof Object.prototype.toString.call, 'function');
  `);
});

test('virtual definitions cannot traverse prototype paths', () => {
  verifyInChild(`
    const schema = new mongoose.Schema({ name: String });
    assert.throws(() => schema.virtual('__proto__.auditRetentionProbe'));
    assert.equal(Object.hasOwn(Object.prototype, 'auditRetentionProbe'), false);
    schema.virtual('label').get(function () { return this.name; });
    const Probe = mongoose.model('VirtualProbe', schema);
    assert.equal(new Probe({ name: 'synthetic' }).label, 'synthetic');
  `);
});
