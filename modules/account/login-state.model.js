'use strict';
/** @file login-state.model.js
 * @description Shared account lockout state; aliases and IP changes share a budget.
 */
const mongoose = require('mongoose');
const { ROLE_MODELS } = require('./session.constants');
const schema = new mongoose.Schema({
  userModel: { type: String, enum: [...new Set(Object.values(ROLE_MODELS))], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  schoolCampus: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null },
  failures: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ userModel: 1, userId: 1 }, { unique: true });
schema.index({ schoolCampus: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('LoginState', schema);
