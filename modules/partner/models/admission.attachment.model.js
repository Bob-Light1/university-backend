'use strict';

/** @file admission.attachment.model.js @description Private applicant files retained until guarded permanent deletion. */
const mongoose = require('mongoose');
const { ATTACHMENT_CATEGORIES, DOSSIER_LIMITS } = require('../../../shared/constants/admission.constants');

const schema = new mongoose.Schema({
  schoolCampus: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', required: true, immutable: true },
  lead: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerLead', required: true, immutable: true },
  category: { type: String, enum: ATTACHMENT_CATEGORIES, required: true, immutable: true },
  originalName: { type: String, required: true, maxlength: 200, immutable: true },
  fileName: { type: String, required: true, immutable: true },
  mimeType: { type: String, enum: ['application/pdf', 'image/png', 'image/jpeg'], required: true, immutable: true },
  sizeBytes: { type: Number, min: 1, max: DOSSIER_LIMITS.maxFileBytes, required: true, immutable: true },
  uploadedBy: { type: String, required: true, immutable: true },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: null },
}, { timestamps: true });
schema.index({ schoolCampus: 1, lead: 1, deletedAt: 1 });
module.exports = mongoose.model('AdmissionAttachment', schema);
