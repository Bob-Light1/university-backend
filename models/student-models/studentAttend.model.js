'use strict';

/**
 * @file studentAttend.model.js
 * @description Mongoose model for student attendance records.
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Campus isolation : schoolCampus (ObjectId → 'Campus')
 *  • student  → ref 'Student' (student_model.js)
 *  • schedule → ref 'StudentSchedule' (studentSchedule.model.js)
 *  • class    → ref 'Class' (class_model.js)
 *  • subject  → ref 'Subject' (subject_model.js)
 *  • recordedBy / justifiedBy → ref 'Teacher' (teacher_model.js)
 *  • lockedBy  → refPath 'lockedByModel' : 'Teacher' | 'Campus' | 'System'
 *  • semester  → 'S1' | 'S2' | 'Annual' (String)
 *  • mongoose.Types.ObjectId() (syntaxe v6+, pas mongoose.Types.ObjectId())
 *  • Date.prototype.getWeekNumber → méthode locale sans pollution du prototype
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Calcule le numéro de semaine ISO d'une date. */
const getWeekNumber = (date) => {
  const d      = new Date(date);
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const days   = Math.floor((d - oneJan) / (24 * 60 * 60 * 1000));
  return Math.ceil((days + oneJan.getDay() + 1) / 7);
};

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────

const studentAttendanceSchema = new mongoose.Schema(
  {
    // ── REFERENCES ──────────────────────────
    student: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Student',
      required: [true, 'Student is required'],
      index:    true,
    },

    /** Séance planifiée (StudentSchedule) */
    schedule: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'StudentSchedule',
      required: [true, 'Schedule is required'],
      index:    true,
    },

    /** Dénormalisé pour les requêtes rapides */
    class: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Class',
      required: [true, 'Class is required'],
      index:    true,
    },

    /** Isolation campus */
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    /** Matière (dénormalisé) */
    subject: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Subject',
      required: [true, 'Subject is required'],
    },

    /** Enseignant qui a enregistré la présence */
    recordedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: [true, 'Recorder is required'],
    },

    // ── STATUT DE PRÉSENCE ───────────────────
    /** false = absent (défaut), true = présent */
    status: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // ── DATE & HEURE ────────────────────────
    attendanceDate: {
      type:     Date,
      required: [true, 'Attendance date is required'],
      index:    true,
    },

    /** Format HH:mm */
    sessionStartTime: { type: String },
    sessionEndTime:   { type: String },

    // ── PÉRIODE ACADÉMIQUE ───────────────────
    academicYear: {
      type:     String,
      required: [true, 'Academic year is required'],
      index:    true,
      validate: {
        validator: (v) => /^\d{4}-\d{4}$/.test(v),
        message:   'Academic year must be in format YYYY-YYYY',
      },
    },

    /** Cohérent avec studentAttendance existant et schedule.base.js */
    semester: {
      type:     String,
      required: [true, 'Semester is required'],
      enum:     ['S1', 'S2', 'Annual'],
      index:    true,
    },

    weekNumber: { type: Number, min: 1, max: 52, index: true },
    month:      { type: Number, min: 1, max: 12, index: true },
    year:       { type: Number, index: true },

    // ── VERROUILLAGE ────────────────────────
    isLocked: { type: Boolean, default: false, index: true },
    lockedAt: { type: Date },
    lockedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      refPath: 'lockedByModel',
    },
    lockedByModel: {
      type: String,
      enum: ['Teacher', 'Campus', 'System'],
    },

    // ── JUSTIFICATION ───────────────────────
    justification: {
      type:      String,
      maxlength: [500, 'Justification must not exceed 500 characters'],
      trim:      true,
    },
    justificationDocument: { type: String },
    isJustified: { type: Boolean, default: false },
    justifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    justifiedAt: { type: Date },

    // ── MÉTADONNÉES ─────────────────────────
    remarks: {
      type:      String,
      maxlength: [500, 'Remarks must not exceed 500 characters'],
      trim:      true,
    },
    isLate:         { type: Boolean, default: false },
    recordedAt:     { type: Date, default: Date.now },
    lastModifiedAt: { type: Date },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

/** Un seul enregistrement par étudiant, par séance, par date */
studentAttendanceSchema.index(
  { student: 1, schedule: 1, attendanceDate: 1 },
  { unique: true }
);

studentAttendanceSchema.index({ schoolCampus: 1, attendanceDate: 1, status: 1 });
studentAttendanceSchema.index({ class: 1, attendanceDate: 1, academicYear: 1, semester: 1 });
studentAttendanceSchema.index({ student: 1, academicYear: 1, semester: 1, status: 1 });
studentAttendanceSchema.index({ schoolCampus: 1, year: 1, month: 1, weekNumber: 1 });

// ─────────────────────────────────────────────
// PRE-SAVE MIDDLEWARE
// ─────────────────────────────────────────────

studentAttendanceSchema.pre('save', function () {
  // Recompute temporal fields only when the date actually changes
  if (this.attendanceDate && (this.isNew || this.isModified('attendanceDate'))) {
    const d         = new Date(this.attendanceDate);
    this.month      = d.getMonth() + 1;
    this.year       = d.getFullYear();
    this.weekNumber = getWeekNumber(d);
  }

  // Prevent status changes on locked records — throw propagates to .save() caller
  if (!this.isNew && this.isLocked && this.isModified('status')) {
    throw new Error(
      'Cannot modify locked attendance record. Add justification instead.'
    );
  }

  // Track last modification timestamp
  if (this.isModified('status') || this.isModified('justification')) {
    this.lastModifiedAt = new Date();
  }
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

/**
 * Verrouille l'enregistrement (impossible de modifier le statut ensuite).
 * @param {ObjectId} lockedBy
 * @param {string}   lockedByModel  – 'Teacher' | 'Campus' | 'System'
 */
studentAttendanceSchema.methods.lock = async function (
  lockedBy,
  lockedByModel = 'System'
) {
  if (this.isLocked) throw new Error('Attendance record is already locked');
  this.isLocked      = true;
  this.lockedAt      = new Date();
  this.lockedBy      = lockedBy;
  this.lockedByModel = lockedByModel;
  await this.save();
  return this;
};

/**
 * Ajoute une justification d'absence.
 * @param {string}   justification
 * @param {ObjectId} justifiedBy  – ref Teacher
 * @param {string}   [doc]        – URL du document justificatif
 */
studentAttendanceSchema.methods.addJustification = async function (
  justification,
  justifiedBy,
  doc = null
) {
  if (this.status === true) {
    throw new Error('Cannot justify absence for present student');
  }
  this.justification = justification;
  this.justifiedBy   = justifiedBy;
  this.justifiedAt   = new Date();
  this.isJustified   = true;
  if (doc) this.justificationDocument = doc;
  await this.save();
  return this;
};

/**
 * Bascule le statut de présence.
 * @param {boolean}  newStatus
 * @param {ObjectId} userId – ref Teacher
 */
studentAttendanceSchema.methods.toggleStatus = async function (newStatus, userId) {
  if (this.isLocked) {
    throw new Error('Cannot modify locked attendance. Add justification instead.');
  }
  this.status         = newStatus;
  this.lastModifiedBy = userId;
  this.lastModifiedAt = new Date();

  if (newStatus === false) {
    this.isJustified            = false;
    this.justification          = null;
    this.justificationDocument  = null;
  }

  await this.save();
  return this;
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * Verrouille tous les enregistrements d'une date donnée sur un campus.
 * @param {Date}     date
 * @param {ObjectId} [campusId]
 */
studentAttendanceSchema.statics.lockDailyAttendance = async function (
  date,
  campusId = null
) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const filter = {
    attendanceDate: { $gte: start, $lte: end },
    isLocked: false,
  };
  if (campusId) filter.schoolCampus = campusId;

  return this.updateMany(filter, {
    $set: {
      isLocked:      true,
      lockedAt:      new Date(),
      lockedByModel: 'System',
    },
  });
};

/**
 * Statistiques de présence pour un étudiant.
 * @param {ObjectId} studentId
 * @param {string}   academicYear
 * @param {string}   semester  – 'S1' | 'S2' | 'Annual'
 * @param {string}   period    – 'all' | 'month' | 'week'
 */
studentAttendanceSchema.statics.getStudentStats = async function (
  studentId,
  academicYear,
  semester,
  period = 'all'
) {
  const matchStage = {
    student: new mongoose.Types.ObjectId(studentId),
    academicYear,
    semester,
  };

  const now = new Date();
  if (period === 'month') {
    matchStage.month = now.getMonth() + 1;
    matchStage.year  = now.getFullYear();
  } else if (period === 'week') {
    matchStage.weekNumber = getWeekNumber(now);
    matchStage.year       = now.getFullYear();
  }

  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:              null,
        totalSessions:    { $sum: 1 },
        presentCount:     { $sum: { $cond: [{ $eq: ['$status', true] }, 1, 0] } },
        absentCount:      { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
        justifiedAbsences:{ $sum: { $cond: ['$isJustified', 1, 0] } },
      },
    },
    {
      $project: {
        _id:                 0,
        totalSessions:       1,
        presentCount:        1,
        absentCount:         1,
        justifiedAbsences:   1,
        unjustifiedAbsences: { $subtract: ['$absentCount', '$justifiedAbsences'] },
        attendanceRate: {
          $cond: [
            { $gt: ['$totalSessions', 0] },
            { $multiply: [{ $divide: ['$presentCount', '$totalSessions'] }, 100] },
            0,
          ],
        },
      },
    },
  ]);

  return stats[0] || {
    totalSessions:       0,
    presentCount:        0,
    absentCount:         0,
    justifiedAbsences:   0,
    unjustifiedAbsences: 0,
    attendanceRate:      0,
  };
};

/**
 * Statistiques de présence pour une classe.
 * @param {ObjectId} classId
 * @param {Date}     [date]
 * @param {string}   period  – 'day' | 'week' | 'month' | 'year'
 */
studentAttendanceSchema.statics.getClassStats = async function (
  classId,
  date = null,
  period = 'day'
) {
  const matchStage = { class: new mongoose.Types.ObjectId(classId) };

  if (date) {
    const d = new Date(date);
    if (period === 'day') {
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      matchStage.attendanceDate = { $gte: start, $lte: end };
    } else if (period === 'week') {
      matchStage.weekNumber = getWeekNumber(d);
      matchStage.year       = d.getFullYear();
    } else if (period === 'month') {
      matchStage.month = d.getMonth() + 1;
      matchStage.year  = d.getFullYear();
    } else if (period === 'year') {
      matchStage.year = d.getFullYear();
    }
  }

  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:          '$student',
        totalSessions:{ $sum: 1 },
        presentCount: { $sum: { $cond: ['$status', 1, 0] } },
        absentCount:  { $sum: { $cond: [{ $not: '$status' }, 1, 0] } },
      },
    },
    {
      $group: {
        _id:               null,
        totalStudents:     { $sum: 1 },
        avgAttendanceRate: {
          $avg: {
            $multiply: [{ $divide: ['$presentCount', '$totalSessions'] }, 100],
          },
        },
        totalSessions: { $avg: '$totalSessions' },
      },
    },
  ]);

  return stats[0] || { totalStudents: 0, avgAttendanceRate: 0, totalSessions: 0 };
};

/**
 * Présences du jour pour une séance et une classe données.
 * @param {ObjectId} scheduleId
 * @param {ObjectId} classId
 * @param {Date}     [date=new Date()]
 */
studentAttendanceSchema.statics.getTodayAttendance = async function (
  scheduleId,
  classId,
  date = new Date()
) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);

  return this.find({
    schedule:       scheduleId,
    class:          classId,
    attendanceDate: { $gte: start, $lte: end },
  })
    .populate('student', 'firstName lastName email profileImage')
    .sort({ 'student.lastName': 1 });
};

const StudentAttendance = mongoose.model('StudentAttendance', studentAttendanceSchema);

module.exports = StudentAttendance;