'use strict';

/**
 * @file final-transcript.model.js
 * @description Final grade report stored at semester close.
 *
 *  Motivation [S2-1] :
 *  ─────────────────────────────────────────────────────────────────
 *  The `computeGeneralAverage` aggregation on the `results` collection can
 *  become expensive when the database holds hundreds of thousands of scores.
 *
 *  Solution: at semester close (lockSemester), the controller generates
 *  one FinalTranscript per student. This document contains all pre-computed
 *  averages. PDF transcripts and read queries use it directly, without
 *  re-aggregating over the large collection.
 *
 *  Project field alignment:
 *  ─────────────────────────
 *  • schoolCampus → multi-tenant isolation
 *  • student      → ref 'Student'
 *  • class        → ref 'Class'
 *  • generatedBy  → String (req.user.id) — consistent with the rest of the project
 *
 *  Lifecycle:
 *  ─────────────────
 *  1. DRAFT     → created automatically at close (lockSemester)
 *  2. VALIDATED → validated by the Campus Manager (parent digital signature)
 *  3. SEALED    → permanently sealed (no further modification possible)
 */

const mongoose = require('mongoose');

// ─── TRANSCRIPT STATUS ────────────────────────────────────────────────────────

const TRANSCRIPT_STATUS = Object.freeze({
  DRAFT:     'DRAFT',      // Auto-generated, awaiting validation
  VALIDATED: 'VALIDATED',  // Validated by Campus Manager
  SEALED:    'SEALED',     // Permanently sealed
});

// ─── SUB-SCHEMAS ──────────────────────────────────────────────────────────────

/** Snapshot of an individual evaluation in the transcript */
const EvaluationSnapshotSchema = new mongoose.Schema(
  {
    evaluationType:  { type: String },
    evaluationTitle: { type: String },
    examPeriod:      { type: String },
    score:           { type: Number },
    maxScore:        { type: Number },
    normalizedScore: { type: Number },
    coefficient:     { type: Number },
    gradeBand:       {
      label:       { type: String },
      letterGrade: { type: String },
      gpa:         { type: Number },
      ectsGrade:   { type: String },
      ectsCredits: { type: Number },
      color:       { type: String },
    },
    teacherRemarks:  { type: String },
  },
  { _id: false }
);

/** Average for a subject over this semester */
const SubjectAverageSchema = new mongoose.Schema(
  {
    subject:      { type: mongoose.Schema.Types.ObjectId, ref: 'Subject' },
    subjectName:  { type: String },
    subjectCode:  { type: String },
    coefficient:  { type: Number },
    /** Weighted average out of 20 for this subject */
    average:      { type: Number },
    /** true if average ≥ passMark of the grading scale */
    isPassing:    { type: Boolean },
    gradeBand:    {
      label:       { type: String },
      letterGrade: { type: String },
      gpa:         { type: Number },
      ectsGrade:   { type: String },
      ectsCredits: { type: Number },
    },
    evaluations:  { type: [EvaluationSnapshotSchema], default: [] },
    /** Class manager's remarks for this subject */
    classManagerRemarks: { type: String },
  },
  { _id: false }
);

/**
 * Parent's digital signature (acknowledgement of receipt of the transcript).
 * [Spec] Parents can digitally sign the transcript at semester end.
 */
const ParentSignatureSchema = new mongoose.Schema(
  {
    signedAt:  { type: Date },
    signedBy:  { type: String },   // e.g. parent identifier or email
    ipAddress: { type: String },
    method:    { type: String, enum: ['click', 'otp', 'biometric'], default: 'click' },
  },
  { _id: false }
);

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────

const FinalTranscriptSchema = new mongoose.Schema(
  {
    // ── CAMPUS ISOLATION ─────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── IDENTIFICATION ────────────────────────
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: [true, 'Student is required'],
      index:    true,
    },
    class: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Class',
      required: [true, 'Class is required'],
    },
    academicYear: {
      type:     String,
      required: [true, 'Academic year is required'],
      match:    [/^\d{4}-\d{4}$/, 'Must be YYYY-YYYY'],
      index:    true,
    },
    semester: {
      type:     String,
      required: [true, 'Semester is required'],
      enum:     ['S1', 'S2', 'Annual'],
      index:    true,
    },

    // ── PRE-COMPUTED AVERAGES ─────────────────
    /** Per-subject breakdown with individual evaluations */
    subjects:       { type: [SubjectAverageSchema], default: [] },
    /** Weighted general average out of 20 */
    generalAverage: { type: Number },
    /** Class rank (computed at generation time) */
    classRank:      { type: Number, min: 1 },
    /** Effectif de la classe au moment du calcul */
    classTotal:     { type: Number, min: 1 },

    // ── ACADEMIC DECISION ─────────────────────
    /**
     * Promotion or orientation decision.
     * E.g. "Admitted to next year", "Repeat year", "Conditional promotion".
     */
    decision:          { type: String, trim: true, maxlength: 200 },
    /**
     * General appreciation from the class council.
     */
    generalAppreciation: { type: String, trim: true, maxlength: 1000 },

    // ── TOKEN QR CODE ─────────────────────────
    /**
     * UUID for PDF transcript authenticity verification.
     * Public endpoint: GET /api/results/verify-transcript/:token
     */
    verificationToken: {
      type:   String,
      unique: true,
      sparse: true,
      index:  true,
    },

    // ── STATE WORKFLOW ────────────────────────
    status: {
      type:    String,
      enum:    Object.values(TRANSCRIPT_STATUS),
      default: TRANSCRIPT_STATUS.DRAFT,
      index:   true,
    },
    validatedAt: { type: Date },
    validatedBy: { type: String },  // req.user.id
    sealedAt:    { type: Date },
    sealedBy:    { type: String },  // req.user.id

    // ── SIGNATURE PARENT ──────────────────────
    parentSignature: { type: ParentSignatureSchema, default: null },

    // ── AUDIT ─────────────────────────────────
    generatedBy:     { type: String },   // req.user.id (manager who triggered lockSemester)
    generatedAt:     { type: Date, default: Date.now },
  },
  {
    timestamps:  true,
    collection:  'final_transcripts',
    toJSON:      { virtuals: true },
    toObject:    { virtuals: true },
  }
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

/** One transcript per student / semester / academic year */
FinalTranscriptSchema.index(
  { student: 1, academicYear: 1, semester: 1 },
  { unique: true, name: 'idx_unique_transcript' }
);
/** Queries by campus + semester */
FinalTranscriptSchema.index(
  { schoolCampus: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_campus_transcripts' }
);

// ─── PRE-SAVE ─────────────────────────────────────────────────────────────────

FinalTranscriptSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    if (this.status === TRANSCRIPT_STATUS.VALIDATED && !this.validatedAt) {
      this.validatedAt = new Date();
    }
    if (this.status === TRANSCRIPT_STATUS.SEALED && !this.sealedAt) {
      this.sealedAt = new Date();
    }
  }
  next();
});

// ─── INSTANCE METHODS ─────────────────────────────────────────────────────────

/**
 * Generates and attaches the QR Code verification token.
 * @returns {Promise<FinalTranscript>}
 */
FinalTranscriptSchema.methods.generateVerificationToken = async function () {
  if (!this.verificationToken) {
    const { randomUUID } = require('crypto');
    this.verificationToken = randomUUID();
    await this.save();
  }
  return this;
};

/**
 * Records the parent's digital signature.
 *
 * @param {string} signedBy   - Parent identifier (email or ID)
 * @param {string} ipAddress  - Request IP address
 * @param {string} [method]   - 'click' | 'otp' | 'biometric'
 * @returns {Promise<FinalTranscript>}
 */
FinalTranscriptSchema.methods.signByParent = async function (signedBy, ipAddress, method = 'click') {
  if (this.parentSignature?.signedAt) {
    throw new Error('This transcript has already been signed.');
  }
  if (this.status !== TRANSCRIPT_STATUS.VALIDATED && this.status !== TRANSCRIPT_STATUS.SEALED) {
    throw new Error('Only VALIDATED or SEALED transcripts can be signed.');
  }
  this.parentSignature = { signedAt: new Date(), signedBy, ipAddress, method };
  await this.save();
  return this;
};

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/**
 * Generates a FinalTranscript for a student from their published results.
 * Called from lockSemester in the workflow controller.
 * Uses results with retakeOf=null to exclude replaced original scores.
 *
 * @param {Object} opts
 * @param {ObjectId} opts.studentId
 * @param {ObjectId} opts.classId
 * @param {ObjectId} opts.campusId
 * @param {string}   opts.academicYear
 * @param {string}   opts.semester
 * @param {string}   opts.generatedBy   - req.user.id
 * @returns {Promise<FinalTranscript>}
 */
FinalTranscriptSchema.statics.generateForStudent = async function ({
  studentId, classId, campusId, academicYear, semester, generatedBy,
}) {
  const { Result, RESULT_STATUS } = require('./result.model');

  // Same aggregation as computeGeneralAverage but more complete
  const pipeline = [
    {
      $match: {
        student:        new mongoose.Types.ObjectId(studentId),
        academicYear,
        semester,
        status:         RESULT_STATUS.PUBLISHED,
        isDeleted:      false,
        retakeOf:       null,   // [S3-2] Excludes original scores replaced by a retake
        examAttendance: { $ne: 'excused' },
      },
    },
    {
      $group: {
        _id:         '$subject',
        // Weighted by each evaluation's coefficient (mirrors computeGeneralAverage).
        weightedSum: { $sum: { $multiply: [{ $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] }, { $ifNull: ['$coefficient', 1] }] } },
        weightTotal: { $sum: { $ifNull: ['$coefficient', 1] } },
        coefficient: { $first: '$coefficient' },
        evaluations: {
          $push: {
            evaluationType:  '$evaluationType',
            evaluationTitle: '$evaluationTitle',
            examPeriod:      '$examPeriod',
            score:           '$score',
            maxScore:        '$maxScore',
            normalizedScore: '$normalizedScore',
            coefficient:     '$coefficient',
            gradeBand:       '$gradeBand',
            teacherRemarks:  '$teacherRemarks',
          },
        },
      },
    },
    {
      $lookup: {
        from:         'subjects',
        localField:   '_id',
        foreignField: '_id',
        as:           'subjectDoc',
      },
    },
    { $unwind: { path: '$subjectDoc', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        subject:     '$_id',
        subjectName: '$subjectDoc.subject_name',
        subjectCode: '$subjectDoc.subject_code',
        coefficient: { $ifNull: ['$subjectDoc.coefficient', '$coefficient'] },
        average:     { $cond: [{ $gt: ['$weightTotal', 0] }, { $round: [{ $divide: ['$weightedSum', '$weightTotal'] }, 2] }, null] },
        evaluations: 1,
      },
    },
  ];

  const subjectResults = await Result.aggregate(pipeline);

  // Compute general average
  let wSum = 0, wTotal = 0;
  for (const s of subjectResults) {
    wSum   += (s.average || 0) * (s.coefficient || 1);
    wTotal += s.coefficient || 1;
  }
  const generalAverage = wTotal > 0 ? parseFloat((wSum / wTotal).toFixed(2)) : null;

  // Upsert: create or update the existing transcript
  const transcript = await this.findOneAndUpdate(
    { student: studentId, academicYear, semester },
    {
      $set: {
        schoolCampus:   campusId,
        class:          classId,
        subjects:       subjectResults,
        generalAverage,
        generatedBy,
        generatedAt:    new Date(),
        status:         'DRAFT',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return transcript;
};

// ─── SERIALISATION ────────────────────────────────────────────────────────────

FinalTranscriptSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  FinalTranscript: mongoose.model('FinalTranscript', FinalTranscriptSchema),
  TRANSCRIPT_STATUS,
};