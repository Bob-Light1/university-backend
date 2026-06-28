'use strict';

/**
 * @file result.model.js  (v2)
 * @description Mongoose model for managing grades and academic results.
 */

const mongoose = require('mongoose');
const { nextResultRef } = require('../../../shared/db/counter.model');

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const RESULT_STATUS = Object.freeze({
  DRAFT:     'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED:  'ARCHIVED',
});

const EVALUATION_TYPE = Object.freeze({
  CC:        'CC',         // Continuous Assessment
  EXAM:      'EXAM',       // Final Exam
  RETAKE:    'RETAKE',     // Retake
  PROJECT:   'PROJECT',    // Project / Thesis
  PRACTICAL: 'PRACTICAL',  // Graded lab work
});

const SEMESTER = Object.freeze({
  S1:     'S1',
  S2:     'S2',
  ANNUAL: 'Annual',
});

/**
 * [resultAjout] Exam period in the academic calendar.
 * Complements evaluationTitle (more descriptive) with a normalized category.
 */
const EXAM_PERIOD = Object.freeze({
  MIDTERM:    'Midterm',
  FINAL:      'Final',
  QUIZ:       'Quiz',
  ASSIGNMENT: 'Assignment',
  PROJECT:    'Project',
  PRACTICAL:  'Practical',
});

// ─── AUDIT ENTRY SUB-SCHEMA ───────────────────────────────────────────────────

/**
 * Audit entry for any post-publication modification.
 * Append-only — never deleted, never modified.
 */
const AuditEntrySchema = new mongoose.Schema(
  {
    modifiedBy: { type: String, required: true },   // req.user.id
    modifiedAt: { type: Date,   default: Date.now },
    field:      { type: String, required: true },   // modified field
    oldValue:   { type: mongoose.Schema.Types.Mixed },
    newValue:   { type: mongoose.Schema.Types.Mixed },
    /** Required reason — minimum 10 characters */
    reason:     { type: String, required: true, trim: true, minlength: 10 },
    ipAddress:  { type: String },
  },
  { _id: true }
);

// ─── GRADE BAND SNAPSHOT SUB-SCHEMA ──────────────────────────────────────────

/**
 * Denormalized snapshot of the grade band at publication time.
 * Ensures that future grading scale changes do not affect old results.
 */
const GradeBandSnapshotSchema = new mongoose.Schema(
  {
    label:       { type: String },
    letterGrade: { type: String },
    gpa:         { type: Number },
    ectsGrade:   { type: String },
    ectsCredits: { type: Number },
    color:       { type: String },
  },
  { _id: false }
);

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────

const ResultSchema = new mongoose.Schema(
  {
    // ── READABLE REFERENCE ────────────────────
    /**
     * Atomic — no duplicate even under heavy concurrency.
     * Format : "RES-2025-00042"
     */
    reference: { type: String, unique: true, index: true },

    // ── CAMPUS ISOLATION ─────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── ACADEMIC CONTEXT ─────────────────────
    academicYear: {
      type:     String,
      required: [true, 'Academic year is required'],
      match:    [/^\d{4}-\d{4}$/, 'Must be YYYY-YYYY'],
      index:    true,
    },
    semester: {
      type:     String,
      required: [true, 'Semester is required'],
      enum:     { values: Object.values(SEMESTER), message: '{VALUE} is not a valid semester' },
      index:    true,
    },
    evaluationType: {
      type:     String,
      required: [true, 'Evaluation type is required'],
      enum:     { values: Object.values(EVALUATION_TYPE), message: '{VALUE} is not a valid evaluation type' },
      index:    true,
    },
    /**
     * Discriminating title to distinguish several CC in the same semester.
     * Ex. "Contrôle n°1", "Examen de Janvier", "Projet Groupe A".
     */
    evaluationTitle: {
      type:      String,
      required:  [true, 'Evaluation title is required'],
      trim:      true,
      maxlength: [200, 'Evaluation title must not exceed 200 characters'],
    },

    // ── [resultAjout] EXAM CONTEXT ───────────
    /**
     * Date on which the evaluation took place.
     * Different from createdAt (entry date) and publishedAt (publication date).
     */
    examDate: {
      type:  Date,
      index: true,
    },
    /**
     * Normalized academic period in the calendar.
     * Complements evaluationTitle with a standard category.
     */
    examPeriod: {
      type: String,
      enum: Object.values(EXAM_PERIOD),
    },
    /** Week of the exam in the academic year (1–52) */
    examWeek: { type: Number, min: 1, max: 52 },
    /** Month of the exam */
    examMonth: {
      type: String,
      enum: [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ],
    },
    /**
     * [resultAjout] Student attendance during the evaluation.
     * 'absent' → score must be 0, 'excused' → not counted in the average.
     */
    examAttendance: {
      type:    String,
      enum:    ['present', 'absent', 'excused'],
      default: 'present',
    },
    /**
     * Special circumstances (ex. medical justification for absence).
     */
    specialCircumstances: {
      type:      String,
      trim:      true,
      maxlength: [300, 'Special circumstances must not exceed 300 characters'],
    },

    // ── PARTICIPANTS ──────────────────────────
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: [true, 'Student is required'],
      index:    true,
    },
    /** Class at grading time (for transcripts and filters) */
    class: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Class',
      required: [true, 'Class is required'],
      index:    true,
    },
    subject: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Subject',
      required: [true, 'Subject is required'],
      index:    true,
    },
    /** Teacher who entered and/or graded the score */
    teacher: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: [true, 'Teacher is required'],
      index:    true,
    },

    // ── NOTATION ─────────────────────────────
    /** Raw score entered by the teacher */
    score: {
      type:     Number,
      required: [true, 'Score is required'],
      min:      [0, 'Score cannot be negative'],
    },
    /** Max score of this evaluation (snapshot at entry time) */
    maxScore: {
      type:     Number,
      required: [true, 'Max score is required'],
      min:      [1, 'Max score must be at least 1'],
    },
    /**
     * Weight of this evaluation in the subject average.
     * Ex. CC = 0.4, Final Exam = 0.6. Default = 1 (equal weights).
     */
    coefficient: {
      type:    Number,
      default: 1,
      min:     [0, 'Coefficient cannot be negative'],
    },

    /**
     * Score normalized to 20 (computed automatically in pre-save).
     * Enables cross-scale comparisons and the general average computation.
     * Rounded to 2 decimals via toFixed to avoid spurious floats.
     */
    normalizedScore: { type: Number },

    /**
     * Denormalized snapshot of the grade band (computed at publication).
     * Insensitive to subsequent grading scale changes.
     */
    gradeBand: { type: GradeBandSnapshotSchema, default: null },

    /** Reference to the grading scale used for this result */
    gradingScale: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'GradingScale',
    },

    // ── [resultAjout] PEDAGOGICAL FEEDBACK ───
    /**
     * Teacher's appreciation (renamed from 'comment' — more explicit).
     * Visible on the transcript.
     */
    teacherRemarks: {
      type:      String,
      trim:      true,
      maxlength: [1000, 'Teacher remarks must not exceed 1000 characters'],
    },
    /**
     * Observations of the class head / pedagogical manager.
     * Added during validation.
     */
    classManagerRemarks: {
      type:      String,
      trim:      true,
      maxlength: [1000, 'Class manager remarks must not exceed 1000 characters'],
    },
    /** Teacher/manager who added classManagerRemarks */
    classManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Teacher',
    },
    /**
     * Student's strengths in this evaluation.
     * Ex. "Bonne maîtrise des algorithmes de tri."
     */
    strengths: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Strengths must not exceed 500 characters'],
    },
    /**
     * Suggested areas for improvement.
     * Ex. "Doit retravailler la gestion des pointeurs."
     */
    improvements: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Improvements must not exceed 500 characters'],
    },

    // ── STATE WORKFLOW ────────────────────────
    status: {
      type:    String,
      enum:    { values: Object.values(RESULT_STATUS), message: '{VALUE} is not a valid status' },
      default: RESULT_STATUS.DRAFT,
      index:   true,
    },
    submittedAt: { type: Date },
    submittedBy: { type: String },   // req.user.id
    publishedAt: { type: Date },
    publishedBy: { type: String },   // req.user.id
    archivedAt:  { type: Date },
    archivedBy:  { type: String },   // req.user.id

    // ── PERIOD LOCKING ────────────────────────
    /**
     * true when the semester is closed (lockSemester).
     * Prevents any modification without ADMIN override.
     */
    periodLocked: { type: Boolean, default: false },

    // ── RETAKE ────────────────────────────────
    /**
     * If this result is a RETAKE, reference to the original grade (failed EXAM).
     * Used to avoid counting the subject twice in the average.
     * The link is guaranteed via transaction in publishResult (RETAKE).
     */
    retakeOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Result',
    },
    /**
     * true if normalizedScore < passMark → student eligible for retake.
     * Computed automatically in pre-save if gradingScale is set.
     */
    isRetakeEligible: { type: Boolean, default: false },

    // ── AUDIT LOG ─────────────────────────────
    /**
     * All post-publication modifications are tracked here.
     * Append-only — never deleted, never modified.
     */
    auditLog: { type: [AuditEntrySchema], default: [] },

    // ── VERIFICATION TOKEN (QR Code) ─────────
    /**
     * UUID generated at first publication.
     * Enables authenticity verification without authentication.
     * Endpoint : GET /api/results/verify/:token
     */
    verificationToken: {
      type:   String,
      unique: true,
      sparse: true,
      index:  true,
    },

    // ── DROPOUT RISK SCORE ────────────────────
    /**
     * 0–100, computed asynchronously after each publication.
     * 0 = no risk, 100 = dropout very likely.
     * Algorithm : linear regression on the last 10 grades.
     */
    dropoutRiskScore: { type: Number, min: 0, max: 100, default: null },

    // ── SOFT DELETE ───────────────────────────
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedBy: { type: String },
  },
  {
    timestamps:  true,
    collection:  'results',
    toJSON:      { virtuals: true },
    toObject:    { virtuals: true },
  }
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

/**
 * Uniqueness : a student can only have one grade per evaluation/title/subject/semester.
 * partial filter excludes soft-deleted records.
 */
ResultSchema.index(
  { student: 1, subject: 1, evaluationType: 1, evaluationTitle: 1, academicYear: 1, semester: 1 },
  {
    unique:                  true,
    name:                    'idx_unique_result_per_eval',
    partialFilterExpression: { isDeleted: false },
  }
);
/** Class sheet */
ResultSchema.index(
  { class: 1, subject: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_class_subject_results' }
);
/** Student transcript */
ResultSchema.index(
  { student: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_student_transcript' }
);
/** Analytics campus */
ResultSchema.index(
  { schoolCampus: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_campus_analytics' }
);
/** Retake queue */
ResultSchema.index(
  { class: 1, isRetakeEligible: 1, status: 1 },
  { name: 'idx_retake_queue' }
);
/** Teacher view */
ResultSchema.index(
  { teacher: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_teacher_results' }
);
/** Queries by exam date */
ResultSchema.index(
  { schoolCampus: 1, examDate: -1 },
  { name: 'idx_exam_date' }
);

// ─── VIRTUALS ─────────────────────────────────────────────────────────────────

/** Raw percentage (0–100) */
ResultSchema.virtual('percentage').get(function () {
  if (!this.maxScore) return null;
  return parseFloat(((this.score / this.maxScore) * 100).toFixed(2));
});

/** Displayed score out of 20 */
ResultSchema.virtual('scoreOn20').get(function () {
  if (!this.maxScore) return null;
  return parseFloat(((this.score / this.maxScore) * 20).toFixed(2));
});

/**
 * [resultAjout] Weighted score for the average computation with coefficient.
 * Equivalent of (percentage × weight) / 100 in the original model.
 */
ResultSchema.virtual('weightedNormalizedScore').get(function () {
  if (!this.maxScore || !this.coefficient) return null;
  return parseFloat((((this.score / this.maxScore) * 20) * this.coefficient).toFixed(2));
});

// ─── PRE-SAVE ─────────────────────────────────────────────────────────────────

ResultSchema.pre('save', async function () {
  try {

    // ── 1. [S2-2] Atomic unique reference ─────────────────────────────────────
    if (!this.reference) {
      // nextResultRef uses findOneAndUpdate + $inc → atomic under concurrency
      this.reference = await nextResultRef(new Date().getFullYear());
    }

    // ── 2. Score normalized to 20 ─────────────────────────────────────────────
    if (this.score != null && this.maxScore) {
      this.normalizedScore = parseFloat(((this.score / this.maxScore) * 20).toFixed(2));
    }

    // ── 3. gradeBand + isRetakeEligible resolution from GradingScale ──────────
    if (this.gradingScale && (this.isNew || this.isModified('score'))) {
      try {
        const { GradingScale } = require('./grading-scale.model');
        const scale = await GradingScale.findById(this.gradingScale).lean();
        if (scale) {
          // Converts the score to the grading scale before resolution
          const scoreInScale = parseFloat(
            ((this.score / this.maxScore) * scale.maxScore).toFixed(4)
          );
          const band = scale.bands.find((b) => scoreInScale >= b.min && scoreInScale <= b.max);
          this.gradeBand = band
            ? {
                label:       band.label,
                letterGrade: band.letterGrade || null,
                gpa:         band.gpa         ?? null,
                ectsGrade:   band.ectsGrade   || null,
                ectsCredits: band.ectsCredits ?? null,
                color:       band.color        || null,
              }
            : null;
          this.isRetakeEligible = scoreInScale < scale.passMark;
        }
      } catch (_err) {
        // GradingScale optional — does not block the save
        console.warn('[Result pre-save] Could not resolve GradingScale:', _err.message);
      }
    }

    // ── 4. Verification token (QR Code) — generated at first publication ─────
    if (this.isModified('status') && this.status === RESULT_STATUS.PUBLISHED && !this.verificationToken) {
      const { randomUUID } = require('crypto');
      this.verificationToken = randomUUID();
      if (!this.publishedAt) this.publishedAt = new Date();
    }

    if (this.isModified('status') && this.status === RESULT_STATUS.ARCHIVED && !this.archivedAt) {
      this.archivedAt = new Date();
    }

    // ── 5. examAttendance / score consistency ─────────────────────────────────
    if (this.examAttendance === 'absent' && this.score !== 0) {
      // Automatic correction — an absent student gets 0
      console.warn(`[Result pre-save] Student absent but score=${this.score}. Forcing score=0.`);
      this.score           = 0;
      this.normalizedScore = 0;
    }

  } catch (err) {
    throw err;
  }
});

// ─── PRE-INSERTMANY ───────────────────────────────────────────────────────────

/**
 * Mongoose runs NO `save` middleware for `insertMany`, so the bulk-entry and
 * CSV-import paths (controller `bulkCreateResults`) would otherwise persist
 * documents WITHOUT:
 *   • a `reference` — the unique non-sparse index then rejects every doc after
 *     the first as a duplicate-key error (E11000), breaking whole-class entry.
 *   • `normalizedScore` / `gradeBand` / `isRetakeEligible` — leaving transcripts,
 *     analytics and retake lists blank for bulk-entered grades.
 *   • the absent → score 0 correction.
 *
 * This hook replicates the relevant pre('save') logic for each inserted doc.
 * GradingScale lookups are memoised so a class sharing one scale costs one query.
 */
ResultSchema.pre('insertMany', async function (next, docs) {
  try {
    if (!Array.isArray(docs) || docs.length === 0) return next();

    const { GradingScale } = require('./grading-scale.model');
    const scaleCache = new Map();

    for (const doc of docs) {
      // 1. Atomic unique reference (mirrors pre('save'))
      if (!doc.reference) {
        doc.reference = await nextResultRef(new Date().getFullYear());
      }

      // 2. examAttendance / score consistency — an absent student scores 0
      if (doc.examAttendance === 'absent' && doc.score !== 0) {
        doc.score = 0;
      }

      // 3. Score normalized to 20
      if (doc.score != null && doc.maxScore) {
        doc.normalizedScore = parseFloat(((doc.score / doc.maxScore) * 20).toFixed(2));
      }

      // 4. gradeBand + isRetakeEligible resolution from GradingScale
      if (doc.gradingScale) {
        const key = doc.gradingScale.toString();
        if (!scaleCache.has(key)) {
          try {
            scaleCache.set(key, await GradingScale.findById(doc.gradingScale).lean());
          } catch {
            scaleCache.set(key, null);
          }
        }
        const scale = scaleCache.get(key);
        if (scale && doc.maxScore) {
          const scoreInScale = parseFloat(((doc.score / doc.maxScore) * scale.maxScore).toFixed(4));
          const band = scale.bands.find((b) => scoreInScale >= b.min && scoreInScale <= b.max);
          doc.gradeBand = band
            ? {
                label:       band.label,
                letterGrade: band.letterGrade || null,
                gpa:         band.gpa         ?? null,
                ectsGrade:   band.ectsGrade   || null,
                ectsCredits: band.ectsCredits ?? null,
                color:       band.color        || null,
              }
            : null;
          doc.isRetakeEligible = scoreInScale < scale.passMark;
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ─── INSTANCE METHODS ─────────────────────────────────────────────────────────

/**
 * Checks whether this result can be modified by a user with this role.
 *
 * Rules :
 *  • DRAFT     → modifiable by the owning teacher and managers
 *  • SUBMITTED → modifiable only by managers
 *  • PUBLISHED / ARCHIVED → requires an ADMIN/DIRECTOR via auditCorrection
 *  • periodLocked → blocks everything except ADMIN/DIRECTOR
 *
 * @param {string} role    - req.user.role
 * @param {string} userId  - req.user.id (to verify TEACHER ownership)
 * @returns {{ ok: boolean, reason: string|null }}
 */
ResultSchema.methods.canModify = function (role, userId) {
  const isGlobal  = role === 'ADMIN' || role === 'DIRECTOR';
  const isManager = isGlobal || role === 'CAMPUS_MANAGER';

  if (this.isDeleted) {
    return { ok: false, reason: 'This result has been deleted.' };
  }

  if (this.periodLocked && !isGlobal) {
    return { ok: false, reason: 'This semester is locked. Contact an administrator.' };
  }

  if (this.status === RESULT_STATUS.PUBLISHED || this.status === RESULT_STATUS.ARCHIVED) {
    if (!isGlobal) {
      return {
        ok:     false,
        reason: `Cannot modify a ${this.status} result. Use the audit endpoint (ADMIN/DIRECTOR only).`,
      };
    }
    return { ok: true, reason: null };
  }

  if (this.status === RESULT_STATUS.SUBMITTED) {
    if (!isManager) {
      return { ok: false, reason: 'Only managers can modify a SUBMITTED result.' };
    }
    return { ok: true, reason: null };
  }

  // DRAFT → owning teacher or manager
  if (this.status === RESULT_STATUS.DRAFT) {
    if (isManager) return { ok: true, reason: null };
    if (this.teacher.toString() === userId) return { ok: true, reason: null };
    return { ok: false, reason: 'You can only modify your own results.' };
  }

  return { ok: false, reason: 'Unknown status.' };
};

/**
 * Records an entry in the audit log.
 * Must be called BEFORE modifying the value of the concerned field.
 *
 * @param {string} field     - Name of the modified field
 * @param {*}      oldValue  - Old value
 * @param {*}      newValue  - New value
 * @param {string} reason    - Reason (min 10 characters)
 * @param {string} userId    - req.user.id
 * @param {string} [ip]      - Request IP
 */
ResultSchema.methods.addAuditEntry = function (field, oldValue, newValue, reason, userId, ip) {
  this.auditLog.push({
    modifiedBy: userId,
    modifiedAt: new Date(),
    field,
    oldValue,
    newValue,
    reason,
    ipAddress:  ip || null,
  });
};

/**
 * [resultAjout] Returns the display color based on the score out of 20.
 * Used by the frontend for the student dashboard.
 *
 * @returns {'#ef4444'|'#f97316'|'#3b82f6'|'#10b981'}
 */
ResultSchema.methods.getScoreColor = function () {
  const s = this.normalizedScore ?? 0;
  if (s < 7)  return '#ef4444';   // Red — in serious difficulty
  if (s < 10) return '#f97316';   // Orange — failing
  if (s < 14) return '#3b82f6';   // Blue — passable to fairly good
  return '#10b981';               // Green — good to excellent
};

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/**
 * Computes a student's weighted average for a subject/semester.
 * Uses normalizedScore (out of 20) and coefficient of each evaluation.
 * [resultAjout] Excludes absentees (examAttendance: 'excused') from the computation.
 *
 * @returns {Promise<{average: number|null, totalWeight: number, count: number}>}
 */
ResultSchema.statics.computeSubjectAverage = async function (
  studentId, subjectId, academicYear, semester
) {
  const results = await this.find({
    student:        studentId,
    subject:        subjectId,
    academicYear,
    semester,
    status:         RESULT_STATUS.PUBLISHED,
    isDeleted:      false,
    retakeOf:       null,
    examAttendance: { $ne: 'excused' },   // Excused absences do not count
  }).select('score maxScore coefficient').lean();

  if (!results.length) return { average: null, totalWeight: 0, count: 0 };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const r of results) {
    const normalized = parseFloat(((r.score / r.maxScore) * 20).toFixed(2));
    const weight     = r.coefficient || 1;
    weightedSum  += normalized * weight;
    totalWeight  += weight;
  }

  return {
    average:     totalWeight > 0 ? parseFloat((weightedSum / totalWeight).toFixed(2)) : null,
    totalWeight,
    count:       results.length,
  };
};

/**
 * Computes a student's general average for a semester.
 * Aggregation with $lookup on subjects to retrieve the coefficients.
 *
 * Performance : all the necessary indexes are declared (idx_student_transcript).
 * For final transcripts, the result is stored in FinalTranscript
 * (final-transcript.model.js) at semester close to avoid
 * recomputing on a massive collection.
 *
 * @returns {Promise<{generalAverage: number|null, subjects: Array}>}
 */
ResultSchema.statics.computeGeneralAverage = async function (
  studentId, academicYear, semester
) {
  const pipeline = [
    {
      $match: {
        student:        new mongoose.Types.ObjectId(studentId),
        academicYear,
        semester,
        status:         RESULT_STATUS.PUBLISHED,
        isDeleted:      false,
        retakeOf:       null,
        examAttendance: { $ne: 'excused' },
      },
    },
    {
      // Subject average is WEIGHTED by each evaluation's coefficient (e.g. CC 0.4
      // + Exam 0.6), not a plain mean — the coefficient field is captured at entry
      // precisely to weight the subject average.
      $group: {
        _id:         '$subject',
        weightedSum: { $sum: { $multiply: [{ $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] }, { $ifNull: ['$coefficient', 1] }] } },
        weightTotal: { $sum: { $ifNull: ['$coefficient', 1] } },
        coefficient: { $first: '$coefficient' },
        count:       { $sum: 1 },
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
        subjectId:   '$_id',
        subjectName: '$subjectDoc.subject_name',
        subjectCode: '$subjectDoc.subject_code',
        coefficient: { $ifNull: ['$subjectDoc.coefficient', '$coefficient'] },
        average:     { $cond: [{ $gt: ['$weightTotal', 0] }, { $round: [{ $divide: ['$weightedSum', '$weightTotal'] }, 2] }, null] },
        count:       1,
      },
    },
  ];

  const subjects = await this.aggregate(pipeline);

  if (!subjects.length) return { generalAverage: null, subjects: [] };

  let weightedSum = 0;
  let totalCoeff  = 0;

  for (const s of subjects) {
    weightedSum += (s.average || 0) * (s.coefficient || 1);
    totalCoeff  += s.coefficient || 1;
  }

  return {
    generalAverage: totalCoeff > 0
      ? parseFloat((weightedSum / totalCoeff).toFixed(2))
      : null,
    subjects,
  };
};

/**
 * Statistical distribution of grades for an evaluation (entire class).
 * Used by the teacher to visualize their class before submission.
 *
 * [resultAjout] Only present students are counted in the distribution.
 */
ResultSchema.statics.getClassDistribution = async function (
  classId, subjectId, evaluationTitle, academicYear, semester
) {
  const results = await this.find({
    class:           classId,
    subject:         subjectId,
    evaluationTitle,
    academicYear,
    semester,
    isDeleted:       false,
    examAttendance:  { $ne: 'absent' },
    status:          { $ne: RESULT_STATUS.ARCHIVED },
  })
    .select('score maxScore examAttendance')
    .lean();

  if (!results.length) return null;

  const normed  = results.map((r) => parseFloat(((r.score / r.maxScore) * 20).toFixed(2)));
  const n       = normed.length;
  const sum     = normed.reduce((a, b) => a + b, 0);
  const mean    = sum / n;
  const min     = Math.min(...normed);
  const max     = Math.max(...normed);
  const stdDev  = Math.sqrt(normed.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n);
  const passing = normed.filter((s) => s >= 10).length;

  // Histogram by 2-point band (/20)
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 2}–${i * 2 + 2}`,
    count: i < 9
      ? normed.filter((s) => s >= i * 2 && s < i * 2 + 2).length
      : normed.filter((s) => s >= 18 && s <= 20).length,  // last bucket includes 20
  }));

  return {
    count:        n,
    mean:         parseFloat(mean.toFixed(2)),
    min:          parseFloat(min.toFixed(2)),
    max:          parseFloat(max.toFixed(2)),
    stdDev:       parseFloat(stdDev.toFixed(2)),
    passingRate:  parseFloat(((passing / n) * 100).toFixed(1)),
    distribution,
  };
};

/**
 * Dropout risk score (0–100) based on the grade trend.
 * Algorithm : linear regression on the last 10 published grades.
 *
 * @returns {Promise<number>}  0 = no risk, 100 = maximal risk
 */
ResultSchema.statics.computeDropoutRisk = async function (studentId, campusId) {
  const recent = await this.find({
    student:      studentId,
    schoolCampus: campusId,
    status:       RESULT_STATUS.PUBLISHED,
    isDeleted:    false,
    examAttendance: { $ne: 'excused' },
  })
    .sort({ publishedAt: -1 })
    .limit(10)
    .select('normalizedScore score maxScore publishedAt')
    .lean();

  if (recent.length < 2) return 0;

  const scores  = recent.map((r) => r.normalizedScore ?? parseFloat(((r.score / r.maxScore) * 20).toFixed(2)));
  const n       = scores.length;
  const mean    = scores.reduce((a, b) => a + b, 0) / n;
  const xMean   = (n - 1) / 2;
  let   covXY = 0, varX = 0;

  for (let i = 0; i < n; i++) {
    covXY += (i - xMean) * (scores[i] - mean);
    varX  += Math.pow(i - xMean, 2);
  }
  const slope = varX !== 0 ? covXY / varX : 0;

  let risk = 0;
  if (slope < -1)      risk += 40;
  else if (slope < 0)  risk += 20;

  if (mean < 7)        risk += 40;
  else if (mean < 10)  risk += 25;
  else if (mean < 12)  risk += 10;

  const failRate = scores.filter((s) => s < 10).length / n;
  risk += Math.round(failRate * 20);

  return Math.min(100, risk);
};

// ─── SERIALISATION ────────────────────────────────────────────────────────────

ResultSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  Result: mongoose.model('Result', ResultSchema),
  RESULT_STATUS,
  EVALUATION_TYPE,
  EXAM_PERIOD,
  SEMESTER,
};