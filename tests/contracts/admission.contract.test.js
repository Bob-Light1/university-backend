'use strict';

/** @file admission.contract.test.js @description Pin actual consumer vocabulary to the backend admission contract. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contract = require('../../shared/constants/admission.constants');

for (const [brick, fallback, relative, keys] of [
  ['FRONTEND', '../../../frontend', 'src/config/admissionConstants.js', ['LEAD_STATUS', 'TRANSITIONS', 'ATTACHMENT_CATEGORIES', 'ADMISSION_ROLES', 'ADMISSION_ERRORS', 'DRAFT_STATUSES']],
  ['PORTAL', '../../../../partner', 'src/lib/admission-constants.ts', ['LEAD_STATUS', 'DRAFT_STATUSES', 'ATTACHMENT_CATEGORIES', 'ADMISSION_ERRORS']],
]) {
  const root = process.env[`ADMISSION_${brick}_ROOT`] || path.resolve(__dirname, fallback);
  const exists = fs.existsSync(path.join(root, 'package.json'));
  (exists ? describe : describe.skip)(`${brick} admission vocabulary`, () => {
    test.each(keys)('%s matches the canonical backend values', (key) => {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      const sandbox = { exports: {} };
      vm.runInNewContext(source.replace(/export const /g, 'exports.'), sandbox);
      expect(JSON.parse(JSON.stringify(sandbox.exports[key]))).toEqual(contract[key]);
    });
  });
}
