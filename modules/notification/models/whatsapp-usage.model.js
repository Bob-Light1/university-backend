'use strict';
/** @file whatsapp-usage.model.js @description Operational monthly campus submission counters; no business TTL. */
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  schoolCampus: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', required: true },
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  used: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
schema.index({ schoolCampus: 1, month: 1 }, { unique: true });
module.exports = mongoose.model('WhatsAppUsage', schema);
