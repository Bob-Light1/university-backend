'use strict';

/** @file announcement.audit.js @description Explicit publication eligibility and persisted announcement projection. */
const { service: audit, constants: { TYPE } } = require('../audit');
const { STATUS, TYPES, ROLES, OPERATION } = require('./announcement.constants');

const FIELDS = Object.freeze({
  title: { type: TYPE.REDACTED }, content: { type: TYPE.REDACTED },
  type: { type: TYPE.ENUM, values: TYPES }, status: { type: TYPE.ENUM, values: Object.values(STATUS) },
  pinned: { type: TYPE.BOOLEAN }, pinnedUntil: { type: TYPE.DATE },
  expiresAt: { type: TYPE.DATE }, publishedAt: { type: TYPE.DATE },
  archivedAt: { type: TYPE.DATE }, deletedAt: { type: TYPE.DATE },
  ...Object.fromEntries(ROLES.map(role => [`targetRole_${role}`, { type: TYPE.BOOLEAN }])),
});
const EXCLUDED_FIELDS = Object.freeze(['_id', '__v', 'createdAt', 'updatedAt', 'schoolCampus',
  'createdBy.userId', 'createdBy.role', 'createdBy.name', 'auditEligible']);
const source = audit.defineSource({ entityType: 'Announcement', operations: Object.values(OPERATION), fields: FIELDS });

/** Reliable persisted publication evidence survives archival and soft deletion. */
function isEligible(record) {
  return record.auditEligible === true || record.status === STATUS.PUBLISHED || record.publishedAt != null;
}

/** Project only known persisted business fields; target-role membership is scalar. */
function project(record) {
  const result = {};
  for (const field of Object.keys(FIELDS)) {
    if (field.startsWith('targetRole_')) result[field] = record.targetRoles.includes(field.slice('targetRole_'.length));
    else if (Object.hasOwn(record, field)) result[field] = record[field];
  }
  return result;
}

module.exports = { source, isEligible, project, FIELDS, EXCLUDED_FIELDS };
