'use strict';
/** @file session.model.js
 * @description Ephemeral authentication sessions. Refresh plaintext is never persisted.
 */
const mongoose = require('mongoose');
const { ROLE_MODELS } = require('./session.constants');
const schema = new mongoose.Schema({
  userModel: { type: String, enum: [...new Set(Object.values(ROLE_MODELS))], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  schoolCampus: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null },
  refreshHash: { type: String, required: true },
  usedRefreshHashes: { type: [String], default: [] },
  fingerprint: { type: String, required: true },
  claims: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ userModel: 1, userId: 1, revokedAt: 1 });
schema.index({ schoolCampus: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('AuthSession', schema);
