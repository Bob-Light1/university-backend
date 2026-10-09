'use strict';
/** @file session-token.js
 * @description In-memory session persistence for existing route-isolation suites.
 * JWT verification and live-session validation stay real; only MongoDB is replaced.
 */
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const C = require('../../modules/account/session.constants');
const sessions = new Map();
const accounts = new Map();

/** Sign a test access token backed by a matching synthetic server session. */
function sign(payload, secret, options) {
  const sid = crypto.randomBytes(12).toString('hex');
  const userModel = C.ROLE_MODELS[payload.role];
  const account = { _id: payload.id, password: 'unit-only-hash', status: 'active',
    ...(payload.campusId ? { schoolCampus: payload.campusId } : {}) };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    password: account.password, status: account.status, campus: payload.campusId ?? null,
    classId: null, departmentId: null, subRole: null,
  })).digest('hex');
  accounts.set(`${userModel}:${payload.id}`, account);
  sessions.set(sid, { _id: sid, userId: payload.id, userModel, schoolCampus: payload.campusId ?? null,
    claims: payload, fingerprint, expiresAt: new Date(Date.now() + C.SESSION_MS), revokedAt: null });
  return jwt.sign({ ...payload, sid }, secret, options);
}

module.exports = {
  sign,
  repository: {
    find: async (sid) => sessions.get(sid) ?? null,
    findAccount: async (model, id) => accounts.get(`${model}:${id}`) ?? null,
    revoke: async () => {},
  },
};
