'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const SpecialNeedsSchema = new mongoose.Schema(
  {
    extraTime:      { type: Number, default: 0 },
    isolatedRoom:   { type: Boolean, default: false },
    largeFont:      { type: Boolean, default: false },
  },
  { _id: false }
);

const examEnrollmentSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    examSession: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ExamSession',
      required: true,
    },
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: true,
    },

    isEligible:       { type: Boolean, required: true },
    eligibilityNotes: { type: String },

    seatNumber:     { type: String, trim: true },
    hallTicketToken: {
      type:    String,
      default: () => uuidv4(),
    },

    checkedInAt: { type: Date },
    checkedInBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },

    attendance: {
      type:    String,
      enum:    ['PRESENT', 'ABSENT', 'EXCUSED', 'LATE'],
      default: 'PRESENT',
    },

    identityVerified: { type: Boolean, default: false },
    specialNeeds:     { type: SpecialNeedsSchema },

    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ── Unique constraint: one enrollment per student per session ─────────────────

examEnrollmentSchema.index(
  { examSession: 1, student: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
examEnrollmentSchema.index({ examSession: 1, attendance: 1 });
examEnrollmentSchema.index({ student: 1, isEligible: 1 });

// ── Invalidate hall ticket after check-in ─────────────────────────────────────

examEnrollmentSchema.methods.consumeHallTicket = function () {
  this.identityVerified = true;
  this.checkedInAt = new Date();
  this.hallTicketToken = null;
};

const ExamEnrollment = mongoose.model('ExamEnrollment', examEnrollmentSchema);
module.exports = ExamEnrollment;
