'use strict';

/**
 * @file final-transcript.model.js
 * @description Relevé de notes définitif stocké à la clôture du semestre.
 *
 *  Motivation [S2-1] :
 *  ─────────────────────────────────────────────────────────────────
 *  L'agrégation `computeGeneralAverage` sur la collection `results` peut
 *  devenir coûteuse quand la base contient des centaines de milliers de notes.
 *
 *  Solution : à la clôture du semestre (lockSemester), le controller génère
 *  un FinalTranscript par étudiant. Ce document contient toutes les moyennes
 *  précalculées. Les bulletins PDF et les requêtes de consultation l'utilisent
 *  directement, sans recalculer sur la collection massive.
 *
 *  Alignements foruni :
 *  ─────────────────────
 *  • schoolCampus → isolation multi-tenant
 *  • student      → ref 'Student'
 *  • class        → ref 'Class'
 *  • generatedBy  → String (req.user.id) — cohérent avec le reste du projet
 *
 *  Cycle de vie :
 *  ─────────────────
 *  1. DRAFT     → créé automatiquement à la clôture (lockSemester)
 *  2. VALIDATED → validé par le Campus Manager (signature numérique parent)
 *  3. SEALED    → scellé définitivement (plus aucune modification possible)
 */

const mongoose = require('mongoose');

// ─── TRANSCRIPT STATUS ────────────────────────────────────────────────────────

const TRANSCRIPT_STATUS = Object.freeze({
  DRAFT:     'DRAFT',      // Généré automatiquement, en attente de validation
  VALIDATED: 'VALIDATED',  // Validé par Campus Manager
  SEALED:    'SEALED',     // Scellé définitivement
});

// ─── SUB-SCHEMAS ──────────────────────────────────────────────────────────────

/** Snapshot d'une évaluation individuelle dans le bulletin */
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

/** Moyenne d'une matière pour ce semestre */
const SubjectAverageSchema = new mongoose.Schema(
  {
    subject:      { type: mongoose.Schema.Types.ObjectId, ref: 'Subject' },
    subjectName:  { type: String },
    subjectCode:  { type: String },
    coefficient:  { type: Number },
    /** Moyenne pondérée sur 20 pour cette matière */
    average:      { type: Number },
    /** true si average ≥ passMark du barème */
    isPassing:    { type: Boolean },
    gradeBand:    {
      label:       { type: String },
      letterGrade: { type: String },
      gpa:         { type: Number },
      ectsGrade:   { type: String },
      ectsCredits: { type: Number },
    },
    evaluations:  { type: [EvaluationSnapshotSchema], default: [] },
    /** Appréciation du chef de classe pour cette matière */
    classManagerRemarks: { type: String },
  },
  { _id: false }
);

/**
 * Signature numérique du parent (accusé de réception du bulletin).
 * [Spec] Les parents peuvent signer numériquement le bulletin en fin de semestre.
 */
const ParentSignatureSchema = new mongoose.Schema(
  {
    signedAt:  { type: Date },
    signedBy:  { type: String },   // ex. identifiant parent ou email
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

    // ── MOYENNES PRÉCALCULÉES ─────────────────
    /** Détail par matière avec évaluations individuelles */
    subjects:       { type: [SubjectAverageSchema], default: [] },
    /** Moyenne générale pondérée sur 20 */
    generalAverage: { type: Number },
    /** Rang dans la classe (calculé à la génération) */
    classRank:      { type: Number, min: 1 },
    /** Effectif de la classe au moment du calcul */
    classTotal:     { type: Number, min: 1 },

    // ── DÉCISION PÉDAGOGIQUE ──────────────────
    /**
     * Décision de passage ou d'orientation.
     * Ex. "Admis en classe supérieure", "Redoublement", "Passage conditionnel".
     */
    decision:          { type: String, trim: true, maxlength: 200 },
    /**
     * Appréciation générale du conseil de classe.
     */
    generalAppreciation: { type: String, trim: true, maxlength: 1000 },

    // ── TOKEN QR CODE ─────────────────────────
    /**
     * UUID pour la vérification d'authenticité du bulletin PDF.
     * Endpoint public : GET /api/results/verify-transcript/:token
     */
    verificationToken: {
      type:   String,
      unique: true,
      sparse: true,
      index:  true,
    },

    // ── WORKFLOW D'ÉTAT ───────────────────────
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
    generatedBy:     { type: String },   // req.user.id (manager qui a lancé lockSemester)
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

/** Un seul bulletin par étudiant / semestre / année */
FinalTranscriptSchema.index(
  { student: 1, academicYear: 1, semester: 1 },
  { unique: true, name: 'idx_unique_transcript' }
);
/** Requêtes par campus + semestre */
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
 * Génère et attache le token de vérification QR Code.
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
 * Enregistre la signature numérique du parent.
 *
 * @param {string} signedBy   - Identifiant du parent (email ou ID)
 * @param {string} ipAddress  - IP de la requête
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
 * Génère un FinalTranscript pour un étudiant à partir des résultats publiés.
 * Appelé depuis lockSemester dans le controller workflow.
 * Utilise les résultats sans retakeOf=null pour éviter les doublons.
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

  // Agrégation identique à computeGeneralAverage mais plus complète
  const pipeline = [
    {
      $match: {
        student:        new mongoose.Types.ObjectId(studentId),
        academicYear,
        semester,
        status:         RESULT_STATUS.PUBLISHED,
        isDeleted:      false,
        retakeOf:       null,   // [S3-2] Exclut les notes originales remplacées
        examAttendance: { $ne: 'excused' },
      },
    },
    {
      $group: {
        _id:         '$subject',
        avgNorm:     { $avg: { $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] } },
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
        average:     { $round: ['$avgNorm', 2] },
        evaluations: 1,
      },
    },
  ];

  const subjectResults = await Result.aggregate(pipeline);

  // Calcul de la moyenne générale
  let wSum = 0, wTotal = 0;
  for (const s of subjectResults) {
    wSum   += (s.average || 0) * (s.coefficient || 1);
    wTotal += s.coefficient || 1;
  }
  const generalAverage = wTotal > 0 ? parseFloat((wSum / wTotal).toFixed(2)) : null;

  // Upsert : crée ou met à jour le bulletin existant
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