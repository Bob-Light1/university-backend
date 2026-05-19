'use strict';

/**
 * @file result.model.js  (v2)
 * @description Modèle Mongoose pour la gestion des notes et résultats académiques.
 */

const mongoose = require('mongoose');
const { nextResultRef } = require('./counter.model');

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const RESULT_STATUS = Object.freeze({
  DRAFT:     'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED:  'ARCHIVED',
});

const EVALUATION_TYPE = Object.freeze({
  CC:        'CC',         // Contrôle Continu
  EXAM:      'EXAM',       // Examen Final
  RETAKE:    'RETAKE',     // Rattrapage
  PROJECT:   'PROJECT',    // Projet / Mémoire
  PRACTICAL: 'PRACTICAL',  // TP noté
});

const SEMESTER = Object.freeze({
  S1:     'S1',
  S2:     'S2',
  ANNUAL: 'Annual',
});

/**
 * [resultAjout] Période d'examen dans le calendrier académique.
 * Complète evaluationTitle (plus descriptif) avec une catégorie normalisée.
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
 * Entrée d'audit pour toute modification post-publication.
 * Append-only — jamais supprimé, jamais modifié.
 */
const AuditEntrySchema = new mongoose.Schema(
  {
    modifiedBy: { type: String, required: true },   // req.user.id
    modifiedAt: { type: Date,   default: Date.now },
    field:      { type: String, required: true },   // champ modifié
    oldValue:   { type: mongoose.Schema.Types.Mixed },
    newValue:   { type: mongoose.Schema.Types.Mixed },
    /** Motif obligatoire — minimum 10 caractères */
    reason:     { type: String, required: true, trim: true, minlength: 10 },
    ipAddress:  { type: String },
  },
  { _id: true }
);

// ─── GRADE BAND SNAPSHOT SUB-SCHEMA ──────────────────────────────────────────

/**
 * Snapshot dénormalisé de la tranche de mention au moment de la publication.
 * Garantit que les changements futurs de barème n'affectent pas les anciens résultats.
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
    // ── RÉFÉRENCE LISIBLE ─────────────────────
    /**
     * Atomique — pas de doublon même sous forte concurrence.
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

    // ── CONTEXTE ACADÉMIQUE ──────────────────
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
     * Titre discriminant pour différencier plusieurs CC dans le même semestre.
     * Ex. "Contrôle n°1", "Examen de Janvier", "Projet Groupe A".
     */
    evaluationTitle: {
      type:      String,
      required:  [true, 'Evaluation title is required'],
      trim:      true,
      maxlength: [200, 'Evaluation title must not exceed 200 characters'],
    },

    // ── [resultAjout] CONTEXTE D'EXAMEN ──────
    /**
     * Date à laquelle l'évaluation a eu lieu.
     * Différent de createdAt (date de saisie) et publishedAt (date de publication).
     */
    examDate: {
      type:  Date,
      index: true,
    },
    /**
     * Période académique normalisée dans le calendrier.
     * Complète evaluationTitle avec une catégorie standard.
     */
    examPeriod: {
      type: String,
      enum: Object.values(EXAM_PERIOD),
    },
    /** Semaine de l'examen dans l'année académique (1–52) */
    examWeek: { type: Number, min: 1, max: 52 },
    /** Mois de l'examen */
    examMonth: {
      type: String,
      enum: [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ],
    },
    /**
     * [resultAjout] Présence de l'étudiant pendant l'évaluation.
     * 'absent' → score doit être 0, 'excused' → pas compté dans la moyenne.
     */
    examAttendance: {
      type:    String,
      enum:    ['present', 'absent', 'excused'],
      default: 'present',
    },
    /**
     * Circonstances particulières (ex. justificatif médical d'absence).
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
    /** Classe au moment de la notation (pour bulletins et filtres) */
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
    /** Enseignant ayant saisi et/ou corrigé la note */
    teacher: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: [true, 'Teacher is required'],
      index:    true,
    },

    // ── NOTATION ─────────────────────────────
    /** Note brute saisie par l'enseignant */
    score: {
      type:     Number,
      required: [true, 'Score is required'],
      min:      [0, 'Score cannot be negative'],
    },
    /** Note maximale de cette évaluation (snapshot au moment de la saisie) */
    maxScore: {
      type:     Number,
      required: [true, 'Max score is required'],
      min:      [1, 'Max score must be at least 1'],
    },
    /**
     * Poids de cette évaluation dans la moyenne de la matière.
     * Ex. CC = 0.4, Examen Final = 0.6. Défaut = 1 (poids égaux).
     */
    coefficient: {
      type:    Number,
      default: 1,
      min:     [0, 'Coefficient cannot be negative'],
    },

    /**
     * Note normalisée sur 20 (calculée automatiquement en pre-save).
     * Permet les comparaisons cross-barèmes et le calcul de moyenne générale.
     * Arrondi à 2 décimales via toFixed pour éviter les flottants parasites.
     */
    normalizedScore: { type: Number },

    /**
     * Snapshot dénormalisé de la tranche de mention (calculé à la publication).
     * Insensible aux changements ultérieurs du barème.
     */
    gradeBand: { type: GradeBandSnapshotSchema, default: null },

    /** Référence au barème utilisé pour ce résultat */
    gradingScale: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'GradingScale',
    },

    // ── [resultAjout] FEEDBACK PÉDAGOGIQUE ───
    /**
     * Appréciation de l'enseignant (renommé depuis 'comment' — plus explicite).
     * Visible sur le bulletin.
     */
    teacherRemarks: {
      type:      String,
      trim:      true,
      maxlength: [1000, 'Teacher remarks must not exceed 1000 characters'],
    },
    /**
     * Observations du chef de classe / gestionnaire pédagogique.
     * Ajoutées lors de la validation.
     */
    classManagerRemarks: {
      type:      String,
      trim:      true,
      maxlength: [1000, 'Class manager remarks must not exceed 1000 characters'],
    },
    /** Enseignant/manager ayant ajouté classManagerRemarks */
    classManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Teacher',
    },
    /**
     * Points forts de l'étudiant dans cette évaluation.
     * Ex. "Bonne maîtrise des algorithmes de tri."
     */
    strengths: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Strengths must not exceed 500 characters'],
    },
    /**
     * Axes d'amélioration suggérés.
     * Ex. "Doit retravailler la gestion des pointeurs."
     */
    improvements: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Improvements must not exceed 500 characters'],
    },

    // ── WORKFLOW D'ÉTAT ───────────────────────
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

    // ── VERROUILLAGE DE PÉRIODE ───────────────
    /**
     * true quand le semestre est clos (lockSemester).
     * Empêche toute modification sans override ADMIN.
     */
    periodLocked: { type: Boolean, default: false },

    // ── RATTRAPAGE ────────────────────────────
    /**
     * Si ce résultat est un RETAKE, référence vers la note originale (EXAM échoué).
     * Utilisé pour éviter de compter la matière deux fois dans la moyenne.
     * La liaison est garantie via transaction dans publishResult (RETAKE).
     */
    retakeOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Result',
    },
    /**
     * true si normalizedScore < passMark → étudiant éligible au rattrapage.
     * Calculé automatiquement en pre-save si gradingScale est renseigné.
     */
    isRetakeEligible: { type: Boolean, default: false },

    // ── AUDIT LOG ─────────────────────────────
    /**
     * Toutes les modifications post-publication sont tracées ici.
     * Append-only — jamais supprimé, jamais modifié.
     */
    auditLog: { type: [AuditEntrySchema], default: [] },

    // ── TOKEN DE VÉRIFICATION (QR Code) ──────
    /**
     * UUID généré à la première publication.
     * Permet la vérification d'authenticité sans authentification.
     * Endpoint : GET /api/results/verify/:token
     */
    verificationToken: {
      type:   String,
      unique: true,
      sparse: true,
      index:  true,
    },

    // ── SCORE DE RISQUE DE DÉCROCHAGE ─────────
    /**
     * 0–100, calculé de façon asynchrone après chaque publication.
     * 0 = aucun risque, 100 = décrochage très probable.
     * Algorithme : régression linéaire sur les 10 dernières notes.
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
 * Unicité : un étudiant ne peut avoir qu'une note par évaluation/titre/matière/semestre.
 * partial filter exclut les enregistrements soft-deleted.
 */
ResultSchema.index(
  { student: 1, subject: 1, evaluationType: 1, evaluationTitle: 1, academicYear: 1, semester: 1 },
  {
    unique:                  true,
    name:                    'idx_unique_result_per_eval',
    partialFilterExpression: { isDeleted: false },
  }
);
/** Feuille de classe */
ResultSchema.index(
  { class: 1, subject: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_class_subject_results' }
);
/** Bulletin étudiant */
ResultSchema.index(
  { student: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_student_transcript' }
);
/** Analytics campus */
ResultSchema.index(
  { schoolCampus: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_campus_analytics' }
);
/** File d'attente de rattrapage */
ResultSchema.index(
  { class: 1, isRetakeEligible: 1, status: 1 },
  { name: 'idx_retake_queue' }
);
/** Vue enseignant */
ResultSchema.index(
  { teacher: 1, academicYear: 1, semester: 1, status: 1 },
  { name: 'idx_teacher_results' }
);
/** Requêtes par date d'examen */
ResultSchema.index(
  { schoolCampus: 1, examDate: -1 },
  { name: 'idx_exam_date' }
);

// ─── VIRTUALS ─────────────────────────────────────────────────────────────────

/** Pourcentage brut (0–100) */
ResultSchema.virtual('percentage').get(function () {
  if (!this.maxScore) return null;
  return parseFloat(((this.score / this.maxScore) * 100).toFixed(2));
});

/** Note sur 20 affichée */
ResultSchema.virtual('scoreOn20').get(function () {
  if (!this.maxScore) return null;
  return parseFloat(((this.score / this.maxScore) * 20).toFixed(2));
});

/**
 * [resultAjout] Score pondéré pour le calcul de moyenne avec coefficient.
 * Équivalent de (percentage × weight) / 100 dans le modèle d'origine.
 */
ResultSchema.virtual('weightedNormalizedScore').get(function () {
  if (!this.maxScore || !this.coefficient) return null;
  return parseFloat((((this.score / this.maxScore) * 20) * this.coefficient).toFixed(2));
});

// ─── PRE-SAVE ─────────────────────────────────────────────────────────────────

ResultSchema.pre('save', async function () {
  try {

    // ── 1. [S2-2] Référence unique atomique ──────────────────────────────────
    if (!this.reference) {
      // nextResultRef utilise findOneAndUpdate + $inc → atomique sous concurrence
      this.reference = await nextResultRef(new Date().getFullYear());
    }

    // ── 2. Note normalisée sur 20 ─────────────────────────────────────────────
    if (this.score != null && this.maxScore) {
      this.normalizedScore = parseFloat(((this.score / this.maxScore) * 20).toFixed(2));
    }

    // ── 3. Résolution gradeBand + isRetakeEligible depuis GradingScale ────────
    if (this.gradingScale && (this.isNew || this.isModified('score'))) {
      try {
        const { GradingScale } = require('./gradingScale.model');
        const scale = await GradingScale.findById(this.gradingScale).lean();
        if (scale) {
          // Convertit le score vers l'échelle du barème avant résolution
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
        // GradingScale optionnel — ne bloque pas la sauvegarde
        console.warn('[Result pre-save] Could not resolve GradingScale:', _err.message);
      }
    }

    // ── 4. Token de vérification (QR Code) — généré à la première publication ─
    if (this.isModified('status') && this.status === RESULT_STATUS.PUBLISHED && !this.verificationToken) {
      const { randomUUID } = require('crypto');
      this.verificationToken = randomUUID();
      if (!this.publishedAt) this.publishedAt = new Date();
    }

    if (this.isModified('status') && this.status === RESULT_STATUS.ARCHIVED && !this.archivedAt) {
      this.archivedAt = new Date();
    }

    // ── 5. Cohérence examAttendance / score ───────────────────────────────────
    if (this.examAttendance === 'absent' && this.score !== 0) {
      // Correction automatique — un étudiant absent a 0
      console.warn(`[Result pre-save] Student absent but score=${this.score}. Forcing score=0.`);
      this.score           = 0;
      this.normalizedScore = 0;
    }

  } catch (err) {
    throw err;
  }
});

// ─── INSTANCE METHODS ─────────────────────────────────────────────────────────

/**
 * Vérifie si ce résultat peut être modifié par un utilisateur avec ce rôle.
 *
 * Règles :
 *  • DRAFT     → modifiable par l'enseignant propriétaire et les managers
 *  • SUBMITTED → modifiable uniquement par les managers
 *  • PUBLISHED / ARCHIVED → nécessite un ADMIN/DIRECTOR via auditCorrection
 *  • periodLocked → bloque tout sauf ADMIN/DIRECTOR
 *
 * @param {string} role    - req.user.role
 * @param {string} userId  - req.user.id (pour vérifier la propriété TEACHER)
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

  // DRAFT → enseignant propriétaire ou manager
  if (this.status === RESULT_STATUS.DRAFT) {
    if (isManager) return { ok: true, reason: null };
    if (this.teacher.toString() === userId) return { ok: true, reason: null };
    return { ok: false, reason: 'You can only modify your own results.' };
  }

  return { ok: false, reason: 'Unknown status.' };
};

/**
 * Enregistre une entrée dans l'audit log.
 * À appeler AVANT de modifier la valeur du champ concerné.
 *
 * @param {string} field     - Nom du champ modifié
 * @param {*}      oldValue  - Ancienne valeur
 * @param {*}      newValue  - Nouvelle valeur
 * @param {string} reason    - Motif (min 10 caractères)
 * @param {string} userId    - req.user.id
 * @param {string} [ip]      - IP de la requête
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
 * [resultAjout] Retourne la couleur d'affichage basée sur la note sur 20.
 * Utilisé par le frontend pour le dashboard étudiant.
 *
 * @returns {'#ef4444'|'#f97316'|'#3b82f6'|'#10b981'}
 */
ResultSchema.methods.getScoreColor = function () {
  const s = this.normalizedScore ?? 0;
  if (s < 7)  return '#ef4444';   // Rouge — en grande difficulté
  if (s < 10) return '#f97316';   // Orange — en échec
  if (s < 14) return '#3b82f6';   // Bleu — passable à assez bien
  return '#10b981';               // Vert — bien à excellent
};

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/**
 * Calcule la moyenne pondérée d'un étudiant pour une matière/semestre.
 * Utilise normalizedScore (sur 20) et coefficient de chaque évaluation.
 * [resultAjout] Exclut les absents (examAttendance: 'excused') du calcul.
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
    examAttendance: { $ne: 'excused' },   // Les absences excusées ne comptent pas
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
 * Calcule la moyenne générale d'un étudiant pour un semestre.
 * Agrégation avec $lookup sur subjects pour récupérer les coefficients.
 *
 * Performance : tous les index nécessaires sont déclarés (idx_student_transcript).
 * Pour les bulletins définitifs, le résultat est stocké dans FinalTranscript
 * (final-transcript.model.js) à la clôture du semestre pour éviter de
 * recalculer sur une collection massive.
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
      $group: {
        _id:         '$subject',
        avgNorm:     { $avg: { $multiply: [{ $divide: ['$score', '$maxScore'] }, 20] } },
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
        average:     { $round: ['$avgNorm', 2] },
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
 * Distribution statistique des notes pour une évaluation (classe entière).
 * Utilisé par l'enseignant pour visualiser sa classe avant soumission.
 *
 * [resultAjout] Seuls les étudiants présents sont comptés dans la distribution.
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

  // Histogramme par tranche de 2 points (/20)
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 2}–${i * 2 + 2}`,
    count: i < 9
      ? normed.filter((s) => s >= i * 2 && s < i * 2 + 2).length
      : normed.filter((s) => s >= 18 && s <= 20).length,  // dernier bucket inclut 20
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
 * Score de risque de décrochage (0–100) basé sur la tendance des notes.
 * Algorithme : régression linéaire sur les 10 dernières notes publiées.
 *
 * @returns {Promise<number>}  0 = aucun risque, 100 = risque maximal
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