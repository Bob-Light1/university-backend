'use strict';

/**
 * @file document-history.builder.js
 * @description Synthetic GED versions, hashed shares and campus templates.
 */
const crypto = require('crypto');
const { oid, pad, stamps, token } = require('../ids');
const { COUNTS, CAMPUS_KEYS } = require('../seed.config');
const { model } = require('../models');

/** Build GED dependents with the same campus as their existing parent document. */
const build = (ctx) => {
  const versions = []; const shares = []; const templates = [];
  const Document = model('Document');
  for (const key of CAMPUS_KEYS) {
    const campusId = ctx.campusIds[key];
    const actor = { userId: ctx.adminIds.ADMIN, userModel: 'Admin' };
    for (let i = 0; i < COUNTS[key].documentVersions; i++) {
      const n = pad(i + 1);
      versions.push({
        _id: oid(`document-version:${key}:${n}`), campusId,
        documentId: oid(`document:${key}:${n}`), version: 1,
        title: `Document ${key}${i + 1}`, status: Document.STATUS.PUBLISHED,
        snapshotReason: 'pre-publish', takenBy: actor, takenAt: ctx.at(-70 + i),
      });
    }
    for (let i = 0; i < COUNTS[key].documentShares; i++) {
      const n = pad(i + 1);
      shares.push({
        _id: oid(`document-share:${key}:${n}`), campusId,
        documentId: oid(`document:${key}:${n}`),
        tokenHash: crypto.createHash('sha256').update(token(`document-share:${key}:${n}`)).digest('hex'),
        expiresAt: ctx.at(i === 0 ? 2 : -1), createdBy: actor, ...stamps(2),
      });
    }
    for (let i = 0; i < COUNTS[key].documentTemplates; i++) {
      const n = pad(i + 1);
      templates.push({
        _id: oid(`document-template:${key}:${n}`), campusId,
        name: `Fixture template ${key}${n}`, type: Document.TYPE.ADMINISTRATIVE,
        layout: [{ blockId: `fixture-${key}-${n}`, type: 'PARAGRAPH', order: 0,
          content: { text: 'Synthetic document template.' } }],
        createdBy: actor, ...stamps(30),
      });
    }
  }
  return [
    { model: 'DocumentVersion', docs: versions },
    { model: 'DocumentShare', docs: shares },
    { model: 'DocumentTemplate', docs: templates },
  ];
};

module.exports = { build };
