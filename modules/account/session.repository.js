'use strict';
/** @file session.repository.js
 * @description Persistence for sessions, account authentication snapshots and locks.
 */
const mongoose = require('mongoose');
const Session = require('./session.model');
const LoginState = require('./login-state.model');
const { LOCK_MS, MAX_ROTATIONS } = require('./session.constants');

/** Read the authoritative credential and authorization state without module cycles. */
async function findAccount(userModel, userId) {
  let query = mongoose.model(userModel).findById(userId)
    .select('+password status role schoolCampus studentClass department subRole partnerCode partnerType');
  if (userModel === 'Staff') query = query.populate('subRole', 'isActive permissions');
  return query.lean();
}

/** Atomically count failures, resetting an expired window without waiting for TTL. */
async function recordFailure(userModel, userId, schoolCampus, now) {
  const filter = { userModel, userId };
  const pipeline = [{ $set: {
    userModel, userId: new mongoose.Types.ObjectId(userId),
    schoolCampus: schoolCampus ? new mongoose.Types.ObjectId(schoolCampus) : null,
    failures: { $cond: [{ $gt: ['$expiresAt', now] }, { $add: ['$failures', 1] }, 1] },
    expiresAt: new Date(now.getTime() + LOCK_MS),
  } }];
  try {
    return await LoginState.findOneAndUpdate(filter, pipeline, { upsert: true, new: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return LoginState.findOneAndUpdate(filter, pipeline, { new: true }).lean();
  }
}

module.exports = {
  findAccount, recordFailure,
  /** Create a session only after credentials and live account state are checked. */
  create: (data) => Session.create(data),
  /** Find a session; the service checks expiry and revocation independently of TTL. */
  find: (id) => Session.findById(id).lean(),
  /** Exactly one request can consume each refresh credential. */
  rotate: (id, oldHash, newHash, now) => Session.findOneAndUpdate({
    _id: id, refreshHash: oldHash, revokedAt: null, expiresAt: { $gt: now },
    [`usedRefreshHashes.${MAX_ROTATIONS - 1}`]: { $exists: false },
  }, { $set: { refreshHash: newHash }, $push: { usedRefreshHashes: oldHash } }, { new: true }).lean(),
  /** Revoke one session or every session belonging to an authenticated actor. */
  revoke: (filter, now) => Session.updateMany({ ...filter, revokedAt: null }, { $set: { revokedAt: now } }),
  /** Read unexpired lock state. */
  lock: (userModel, userId, now) => LoginState.findOne({ userModel, userId, expiresAt: { $gt: now } }).lean(),
  /** Clear failures only after a successful credential check. */
  clearFailures: (userModel, userId) => LoginState.updateOne({ userModel, userId }, { $set: { failures: 0 } }),
};
