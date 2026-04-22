'use strict';

/**
 * @file teacherAttend.model.js
 * @description Mongoose model for teacher attendance records.
 *
 *  Alignements avec le backend foruni :
 *  ──────────────────────────────────────
 *  • Campus isolation : schoolCampus (ObjectId → 'Campus')
 *  • teacher     → ref 'Teacher' (teacher_model.js)
 *  • schedule    → ref 'TeacherSchedule' (teacherSchedule.model.js)
 *  • class       → ref 'Class'   (class_model.js)
 *  • subject     → ref 'Subject' (subject_model.js)
 *  • recordedBy / justifiedBy → ref 'Teacher'
 *  • replacementTeacher → ref 'Teacher'
 *  • semester → 'S1' | 'S2' | 'Annual'
 *  • mongoose.Types.ObjectId() — syntaxe v6+
 *  • Suppression de la pollution de Date.prototype
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const getWeekNumber = (date) => {
  const d      = new Date(date);
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const days   = Math.floor((d - oneJan) / (24 * 60 * 60 * 1000));
  return Math.ceil((days + oneJan.getDay() + 1) / 7);
};

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────

const teacherAttendanceSchema = new mongoose.Schema(
  {
    // ── REFERENCES ──────────────────────────
    teacher: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: [true, 'Teacher is required'],
      index:    true,
    },

    /** Séance planifiée (TeacherSchedule) */
    schedule: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'TeacherSchedule',
      required: [true, 'Schedule is required'],
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

    /** Classe concernée (dénormalisé) */
    class: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Class',
      required: [true, 'Class is required'],
    },

    /**
     * Campus Manager qui a enregistré la présence.
     * Le Campus Manager peut être un Teacher avec le rôle CAMPUS_MANAGER
     * dans le JWT (req.user.role === 'CAMPUS_MANAGER').
     */
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
    isJustified:  { type: Boolean, default: false },
    justifiedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    justifiedAt:  { type: Date },

    // ── PAIE ────────────────────────────────
    /** Durée de la séance en minutes (calculée automatiquement) */
    sessionDuration: { type: Number },
    isPaid:      { type: Boolean, default: false, index: true },
    paymentRef:  { type: String },
    paidAt:      { type: Date },

    // ── ENSEIGNANT REMPLAÇANT ────────────────
    hasReplacement:      { type: Boolean, default: false },
    replacementTeacher:  { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    replacementNotes:    {
      type:      String,
      maxlength: [300, 'Replacement notes must not exceed 300 characters'],
    },

    // ── MÉTADONNÉES ─────────────────────────
    remarks: {
      type:      String,
      maxlength: [500, 'Remarks must not exceed 500 characters'],
      trim:      true,
    },
    isLate:      { type: Boolean, default: false },
    arrivalTime: { type: String },   // HH:mm
    recordedAt:  { type: Date, default: Date.now },
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

/** Un seul enregistrement par enseignant, par séance, par date */
teacherAttendanceSchema.index(
  { teacher: 1, schedule: 1, attendanceDate: 1 },
  { unique: true }
);

teacherAttendanceSchema.index({ schoolCampus: 1, attendanceDate: 1, status: 1 });
teacherAttendanceSchema.index({ teacher: 1, academicYear: 1, semester: 1, status: 1 });
teacherAttendanceSchema.index({ schoolCampus: 1, year: 1, month: 1, isPaid: 1 });

// ─────────────────────────────────────────────
// PRE-SAVE MIDDLEWARE
// ─────────────────────────────────────────────

teacherAttendanceSchema.pre('save', function () {
  if (this.attendanceDate && (this.isNew || this.isModified('attendanceDate'))) {
    const d         = new Date(this.attendanceDate);
    this.month      = d.getMonth() + 1;
    this.year       = d.getFullYear();
    this.weekNumber = getWeekNumber(d);
  }

  if (this.sessionStartTime && this.sessionEndTime &&
      (this.isNew || this.isModified('sessionStartTime') || this.isModified('sessionEndTime'))) {
    const [sh, sm] = this.sessionStartTime.split(':').map(Number);
    const [eh, em] = this.sessionEndTime.split(':').map(Number);
    this.sessionDuration = (eh * 60 + em) - (sh * 60 + sm);
  }

  if (!this.isNew && this.isLocked && this.isModified('status')) {
    throw new Error(
      'Cannot modify locked attendance. Add justification instead.'
    );
  }

  if (this.isModified('status') || this.isModified('justification')) {
    this.lastModifiedAt = new Date();
  }
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

teacherAttendanceSchema.methods.lock = async function (
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

teacherAttendanceSchema.methods.addJustification = async function (
  justification,
  justifiedBy,
  doc = null
) {
  if (this.status === true) {
    throw new Error('Cannot justify absence for present teacher');
  }
  this.justification = justification;
  this.justifiedBy   = justifiedBy;
  this.justifiedAt   = new Date();
  this.isJustified   = true;
  if (doc) this.justificationDocument = doc;
  await this.save();
  return this;
};

teacherAttendanceSchema.methods.toggleStatus = async function (newStatus, userId) {
  if (this.isLocked) {
    throw new Error('Cannot modify locked attendance. Add justification instead.');
  }
  this.status         = newStatus;
  this.lastModifiedBy = userId;
  this.lastModifiedAt = new Date();

  if (newStatus === false) {
    this.isJustified           = false;
    this.justification         = null;
    this.justificationDocument = null;
  }

  await this.save();
  return this;
};

/**
 * Marque la séance comme payée.
 * @param {string} paymentRef
 */
teacherAttendanceSchema.methods.markAsPaid = async function (paymentRef) {
  if (!this.status) throw new Error('Cannot pay for absent teacher');
  this.isPaid     = true;
  this.paymentRef = paymentRef;
  this.paidAt     = new Date();
  await this.save();
  return this;
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * Verrouille tous les enregistrements d'une date sur un campus.
 */
teacherAttendanceSchema.statics.lockDailyAttendance = async function (
  date,
  campusId = null
) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);

  const filter = { attendanceDate: { $gte: start, $lte: end }, isLocked: false };
  if (campusId) filter.schoolCampus = campusId;

  return this.updateMany(filter, {
    $set: { isLocked: true, lockedAt: new Date(), lockedByModel: 'System' },
  });
};

/**
 * Statistiques de présence pour un enseignant.
 */
teacherAttendanceSchema.statics.getTeacherStats = async function (
  teacherId,
  academicYear,
  semester,
  period = 'all'
) {
  const matchStage = {
    teacher: new mongoose.Types.ObjectId(teacherId),
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
        _id:               null,
        totalSessions:     { $sum: 1 },
        presentCount:      { $sum: { $cond: ['$status', 1, 0] } },
        absentCount:       { $sum: { $cond: [{ $not: '$status' }, 1, 0] } },
        justifiedAbsences: { $sum: { $cond: ['$isJustified', 1, 0] } },
        totalMinutes:      { $sum: '$sessionDuration' },
        paidSessions:      { $sum: { $cond: ['$isPaid', 1, 0] } },
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
        totalHours:    { $divide: ['$totalMinutes', 60] },
        paidSessions:  1,
        unpaidSessions:{ $subtract: ['$presentCount', '$paidSessions'] },
      },
    },
  ]);

  return stats[0] || {
    totalSessions: 0, presentCount: 0, absentCount: 0,
    justifiedAbsences: 0, unjustifiedAbsences: 0,
    attendanceRate: 0, totalHours: 0, paidSessions: 0, unpaidSessions: 0,
  };
};

/**
 * Statistiques de présence par campus.
 */
teacherAttendanceSchema.statics.getCampusStats = async function (
  campusId,
  date = null,
  period = 'day'
) {
  const matchStage = { schoolCampus: new mongoose.Types.ObjectId(campusId) };

  if (date) {
    const d = new Date(date);
    if (period === 'day') {
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      matchStage.attendanceDate = { $gte: start, $lte: end };
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
        _id:              null,
        totalTeachers:    { $addToSet: '$teacher' },
        totalSessions:    { $sum: 1 },
        presentSessions:  { $sum: { $cond: ['$status', 1, 0] } },
        absentSessions:   { $sum: { $cond: [{ $not: '$status' }, 1, 0] } },
      },
    },
    {
      $project: {
        _id:             0,
        totalTeachers:   { $size: '$totalTeachers' },
        totalSessions:   1,
        presentSessions: 1,
        absentSessions:  1,
        attendanceRate: {
          $cond: [
            { $gt: ['$totalSessions', 0] },
            { $multiply: [{ $divide: ['$presentSessions', '$totalSessions'] }, 100] },
            0,
          ],
        },
      },
    },
  ]);

  return stats[0] || {
    totalTeachers: 0, totalSessions: 0,
    presentSessions: 0, absentSessions: 0, attendanceRate: 0,
  };
};

/**
 * Présences du jour pour un campus donné.
 */
teacherAttendanceSchema.statics.getTodayAttendance = async function (
  campusId,
  date = new Date()
) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);

  return this.find({
    schoolCampus:   campusId,
    attendanceDate: { $gte: start, $lte: end },
  })
    .populate('teacher', 'firstName lastName email profileImage')
    .populate('schedule', 'startTime endTime')
    .populate('class', 'className')
    .sort({ sessionStartTime: 1 });
};

const TeacherAttendance = mongoose.model('TeacherAttendance', teacherAttendanceSchema);

module.exports = TeacherAttendance;