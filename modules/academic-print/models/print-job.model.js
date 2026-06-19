'use strict';

const mongoose = require('mongoose');

/**
 * @file print-job.model.js — persistent batch print jobs.
 *
 * One document = one batch print request (a class of ID cards, transcripts, …).
 * Persisting in MongoDB (instead of an in-process Map) makes job status and the
 * resulting PDFs reachable from ANY worker in a multi-process / load-balanced
 * deployment, and lets jobs survive restarts. The queue worker claims jobs with
 * an atomic findOneAndUpdate (PENDING → PROCESSING) so only one worker runs each.
 *
 * ONLY `print-job.repository.js` touches this model.
 */

const STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'PARTIAL', 'ERROR', 'CANCELLED'];
const TYPES    = ['STUDENT_CARD', 'TRANSCRIPT', 'ENROLLMENT', 'TIMETABLE', 'STUDENT_LIST', 'TEACHER_LIST'];

// Job metadata retention — aligned with the on-disk PDF TTL (30 days).
const JOB_TTL_DAYS = parseInt(process.env.PRINT_JOB_TTL_DAYS || '30', 10);

const targetSchema = new mongoose.Schema({
  id:   { type: String, required: true },
  name: { type: String, default: '' },
}, { _id: false });

const resultSchema = new mongoose.Schema({
  targetId:    { type: String, required: true },
  targetName:  { type: String, default: '' },
  fileName:    { type: String, default: null },
  error:       { type: String, default: null },
  completedAt: { type: Date,   default: null },
  failedAt:    { type: Date,   default: null },
}, { _id: false });

const printJobSchema = new mongoose.Schema(
  {
    campusId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', required: true, index: true },
    type:        { type: String, enum: TYPES, required: true },
    status:      { type: String, enum: STATUSES, default: 'PENDING', index: true },
    params:      { type: mongoose.Schema.Types.Mixed, default: {} },
    targets:     { type: [targetSchema], default: [] },
    results:     { type: [resultSchema], default: [] },
    progress: {
      total:  { type: Number, default: 0 },
      done:   { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    requestedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
    startedAt:       { type: Date, default: null },
    completedAt:     { type: Date, default: null },
    // Set when a worker claims the job — used to detect/requeue stale PROCESSING jobs.
    workerClaimedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Campus job history (most recent first).
printJobSchema.index({ campusId: 1, createdAt: -1 });
// Queue worker: claim pending / sweep stale processing.
printJobSchema.index({ status: 1, workerClaimedAt: 1 });
// Auto-expire job metadata after the retention window.
printJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: JOB_TTL_DAYS * 24 * 60 * 60 });

printJobSchema.statics.STATUSES = STATUSES;
printJobSchema.statics.TYPES    = TYPES;

module.exports = mongoose.model('PrintJob', printJobSchema);
