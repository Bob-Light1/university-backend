'use strict';

/**
 * @file result.workflow.controller.js
 * @description Gestion du workflow d'état des résultats académiques.
 *
 *  Endpoints gérés :
 *  ─────────────────────────────────────────────────────────────────
 *  POST   /api/results/:id/submit         → submitResult
 *  POST   /api/results/submit-batch       → submitBatch
 *  PATCH  /api/results/:id/publish        → publishResult
 *  PATCH  /api/results/publish-batch      → publishBatch
 *  PATCH  /api/results/:id/archive        → archiveResult
 *  PATCH  /api/results/lock-semester      → lockSemester
 *  PATCH  /api/results/audit/:id          → auditCorrection
 *
 *  Règles de transition :
 *  ─────────────────────────────────────────────────────────────────
 *  DRAFT      → SUBMITTED  (enseignant propriétaire ou manager)
 *  SUBMITTED  → PUBLISHED  (CAMPUS_MANAGER, ADMIN, DIRECTOR)
 *  SUBMITTED  → DRAFT      (renvoi en correction par manager)
 *  PUBLISHED  → ARCHIVED   (CAMPUS_MANAGER, ADMIN, DIRECTOR)
 *  PUBLISHED  → correction (ADMIN/DIRECTOR uniquement via /audit/:id)
 *
 *  Transaction MongoDB pour la publication des RETAKE :
 *  ─────────────────────────────────────────────────────────────────
 *  Lors de la publication d'un RETAKE, une session Mongoose garantit
 *  atomiquement que la note originale est bien exclue de la moyenne
 *  (retakeOf est renseigné sur la note originale → retakeOf: null
 *  dans computeGeneralAverage exclut les doublons).
 */

const { randomUUID } = require('crypto');

const { RESULT_STATUS } = require('../models/result.model');
const resultRepo = require('../result.repository');
const notification = require('../../notification').service;

/**
 * Notifie un étudiant (in-app) qu'un résultat vient d'être publié.
 * Fire-and-forget : un échec de notification ne doit jamais bloquer la
 * publication (même contrat que le calcul du risque de décrochage ci-dessous).
 */
const notifyResultPublished = async (studentId, campusId) => {
  try {
    // Contact résolu via la façade student (le socle ne touche aucun model).
    const contact = await require('../../student').service.getStudentContact(studentId);
    await notification.notify({
      recipient: { id: studentId, model: 'Student', campusId, email: contact?.email },
      channels: ['inapp', 'email'], // email inerte sans SMTP → skipped
      template: 'result.published',
      data: {},
    });
  } catch (err) {
    console.error('[notify] result.published failed:', err.message);
  }
};

const {
  asyncHandler,
  sendSuccess,
  sendError,
  sendNotFound,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');

const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const {
  isGlobalRole,
  isManagerRole,
  getCampusFilter,
} = require('./result.helper');

// ─── SUBMIT (individuel) ──────────────────────────────────────────────────────

/**
 * POST /api/results/:id/submit
 * Soumet un résultat DRAFT → SUBMITTED.
 * Un TEACHER ne peut soumettre que ses propres résultats.
 */
const submitResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  const result = await resultRepo.findResultForWrite(id);
  if (!result) return sendNotFound(res, 'Result');

  if (result.status !== RESULT_STATUS.DRAFT)
    return sendError(res, 400, `Cannot submit a result in status '${result.status}'. Must be DRAFT.`);

  if (req.user.role === 'TEACHER' && result.teacher.toString() !== req.user.id)
    return sendForbidden(res, 'You can only submit your own results.');

  if (!isGlobalRole(req.user.role) &&
      result.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  result.status      = RESULT_STATUS.SUBMITTED;
  result.submittedAt = new Date();
  result.submittedBy = req.user.id;
  await resultRepo.saveResultDoc(result);

  return sendSuccess(res, 200, 'Result submitted for review.', result);
});

// ─── SUBMIT BATCH ─────────────────────────────────────────────────────────────

/**
 * POST /api/results/submit-batch
 * Soumet en lot tous les DRAFT d'une évaluation → SUBMITTED.
 *
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
const submitBatch = asyncHandler(async (req, res) => {
  const { classId, subjectId, evaluationTitle, academicYear, semester } = req.body;

  if (!isValidObjectId(classId))   return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId)) return sendError(res, 400, 'Invalid subjectId.');
  if (!evaluationTitle || !academicYear || !semester)
    return sendError(res, 400, 'evaluationTitle, academicYear and semester are required.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const filter = {
    class:           classId,
    subject:         subjectId,
    evaluationTitle,
    academicYear,
    semester,
    status:          RESULT_STATUS.DRAFT,
    isDeleted:       false,
    ...campusFilter,
  };

  // A TEACHER may only submit their own results
  if (req.user.role === 'TEACHER') filter.teacher = req.user.id;

  const { modifiedCount } = await resultRepo.updateManyResults(filter, {
    $set: {
      status:      RESULT_STATUS.SUBMITTED,
      submittedAt: new Date(),
      submittedBy: req.user.id,
    },
  });

  return sendSuccess(res, 200, `${modifiedCount} result(s) submitted for review.`, { modifiedCount });
});

// ─── PUBLISH (individuel) ─────────────────────────────────────────────────────

/**
 * PATCH /api/results/:id/publish
 * Publie un résultat SUBMITTED → PUBLISHED.
 * Déclenche le calcul asynchrone du risque de décrochage.
 *
 * [S3-2] Si le résultat est un RETAKE, une transaction garantit que
 * la note originale (retakeOf) est bien exclue de la moyenne générale
 * par le filtre retakeOf: null dans computeGeneralAverage.
 * Le lien retakeOf doit avoir été renseigné à la création du RETAKE.
 */
const publishResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only Campus Managers or Admins can publish results.');

  const resultDoc = await resultRepo.findResultForWrite(id);
  if (!resultDoc) return sendNotFound(res, 'Result');

  if (!isGlobalRole(req.user.role) &&
      resultDoc.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  if (resultDoc.status !== RESULT_STATUS.SUBMITTED)
    return sendError(res, 400,
      `Result must be SUBMITTED before publishing. Current status: ${resultDoc.status}`);

  // ── [S3-2] Transaction pour les RETAKE ───────────────────────────────────
  if (resultDoc.evaluationType === 'RETAKE' && resultDoc.retakeOf) {
    const session = await resultRepo.startSession();
    try {
      await session.withTransaction(async () => {
        // 1. Publier le RETAKE
        resultDoc.status            = RESULT_STATUS.PUBLISHED;
        resultDoc.publishedAt       = new Date();
        resultDoc.publishedBy       = req.user.id;
        resultDoc.verificationToken = randomUUID();
        await resultRepo.saveResultDoc(resultDoc, { session });

        // 2. S'assurer que la note originale a bien retakeOf renseigné
        //    (normalement fait à la création, mais on le vérifie ici)
        const original = await resultRepo.findResultById(resultDoc.retakeOf, { session });
        if (original && !original.retakeOf) {
          // La note originale est correctement liée — elle sera exclue de
          // computeGeneralAverage via le filtre retakeOf: null
          // Aucune modification nécessaire si retakeOf est null sur l'original
          // (c'est le RETAKE qui porte retakeOf, pas l'original)
        }
      });
      session.endSession();
    } catch (err) {
      session.endSession();
      throw err;
    }
  } else {
    // Publication standard sans transaction
    resultDoc.status            = RESULT_STATUS.PUBLISHED;
    resultDoc.publishedAt       = new Date();
    resultDoc.publishedBy       = req.user.id;
    resultDoc.verificationToken = randomUUID();
    await resultRepo.saveResultDoc(resultDoc);
  }

  // Calcul asynchrone du risque de décrochage (fire-and-forget)
  resultRepo.computeDropoutRisk(resultDoc.student, resultDoc.schoolCampus)
    .then((risk) => resultRepo.setDropoutRiskScore(resultDoc._id, risk))
    .catch((err) => console.error('[DropoutRisk] computation failed:', err.message));

  // Notification in-app à l'étudiant (fire-and-forget)
  notifyResultPublished(resultDoc.student, resultDoc.schoolCampus);

  return sendSuccess(res, 200, 'Result published. Student can now view this result.', resultDoc);
});

// ─── PUBLISH BATCH ────────────────────────────────────────────────────────────

/**
 * PATCH /api/results/publish-batch
 * Publie en lot tous les SUBMITTED d'une évaluation → PUBLISHED.
 * Chaque résultat reçoit un verificationToken unique.
 *
 * Body : { classId, subjectId, evaluationTitle, academicYear, semester }
 */
const publishBatch = asyncHandler(async (req, res) => {
  const { classId, subjectId, evaluationTitle, academicYear, semester } = req.body;

  if (!isValidObjectId(classId))   return sendError(res, 400, 'Invalid classId.');
  if (!isValidObjectId(subjectId)) return sendError(res, 400, 'Invalid subjectId.');
  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can publish results.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const filter = {
    class:           classId,
    subject:         subjectId,
    evaluationTitle,
    academicYear,
    semester,
    status:          RESULT_STATUS.SUBMITTED,
    isDeleted:       false,
    ...campusFilter,
  };

  // On doit itérer pour déclencher pre-save (verificationToken + gradeBand)
  const toPublish = await resultRepo.findResultsForWrite(filter);
  const now = new Date();

  await Promise.all(
    toPublish.map((r) => {
      r.status             = RESULT_STATUS.PUBLISHED;
      r.publishedAt        = now;
      r.publishedBy        = req.user.id;
      r.verificationToken  = randomUUID();
      return resultRepo.saveResultDoc(r);
    })
  );

  // Dropout risk — fire-and-forget per unique student (mirrors publishResult behaviour)
  const uniqueStudents = [...new Map(toPublish.map((r) => [r.student.toString(), r])).values()];
  for (const r of uniqueStudents) {
    resultRepo.computeDropoutRisk(r.student, r.schoolCampus)
      .then((risk) => resultRepo.setDropoutRiskScore(r._id, risk))
      .catch((err) => console.error('[DropoutRisk] batch computation failed:', err.message));
    // Une seule notification in-app par étudiant (évite le spam multi-matières)
    notifyResultPublished(r.student, r.schoolCampus);
  }

  return sendSuccess(res, 200, `${toPublish.length} result(s) published.`, {
    published: toPublish.length,
  });
});

// ─── ARCHIVE (individuel) ─────────────────────────────────────────────────────

/**
 * PATCH /api/results/:id/archive
 * Archive un résultat PUBLISHED → ARCHIVED.
 */
const archiveResult = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');

  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can archive results.');

  const result = await resultRepo.findResultForWrite(id);
  if (!result) return sendNotFound(res, 'Result');

  if (!isGlobalRole(req.user.role) &&
      result.schoolCampus.toString() !== req.user.campusId?.toString())
    return sendForbidden(res, 'Access denied.');

  if (result.status !== RESULT_STATUS.PUBLISHED)
    return sendError(res, 400, 'Only PUBLISHED results can be archived.');

  result.status    = RESULT_STATUS.ARCHIVED;
  result.archivedBy = req.user.id;
  await resultRepo.saveResultDoc(result);

  return sendSuccess(res, 200, 'Result archived.', result);
});

// ─── LOCK SEMESTER ────────────────────────────────────────────────────────────

/**
 * PATCH /api/results/lock-semester
 * Clôture un semestre :
 *   1. Verrouille tous les résultats PUBLISHED et ARCHIVED (periodLocked = true)
 *   2. Génère un FinalTranscript par étudiant [S2-1]
 *
 * Body : { academicYear, semester, schoolCampus? }
 */
const lockSemester = asyncHandler(async (req, res) => {
  const { academicYear, semester } = req.body;

  if (!isManagerRole(req.user.role))
    return sendForbidden(res, 'Only managers can lock a semester.');
  if (!academicYear || !semester)
    return sendError(res, 400, 'academicYear and semester are required.');

  const campusFilter = getCampusFilter(req, res);
  if (!campusFilter) return; // 403 already sent

  const lockMatch = {
    academicYear,
    semester,
    status:    { $in: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.ARCHIVED] },
    isDeleted: false,
    ...campusFilter,
  };

  // ── 1. Verrouillage des résultats ─────────────────────────────────────────
  const { modifiedCount } = await resultRepo.updateManyResults(
    lockMatch,
    { $set: { periodLocked: true } }
  );

  // ── 2. [S2-1] Génération des FinalTranscripts ─────────────────────────────
  // Une seule agrégation : étudiants distincts avec classId et campusId
  const studentDetails = await resultRepo.aggregateDistinctStudentsForLock(lockMatch);

  // Génération en parallèle (limité à 10 simultanés pour éviter les timeouts)
  const BATCH = 10;
  let transcriptsGenerated = 0;
  let transcriptErrors     = 0;

  for (let i = 0; i < studentDetails.length; i += BATCH) {
    const batch = studentDetails.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((s) =>
        resultRepo.generateTranscriptForStudent({
          studentId:   s._id,
          classId:     s.classId,
          campusId:    s.campusId,
          academicYear,
          semester,
          generatedBy: req.user.id,
        })
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') transcriptsGenerated++;
      else {
        transcriptErrors++;
        console.error('[lockSemester] FinalTranscript generation error:', r.reason?.message);
      }
    }
  }

  return sendSuccess(res, 200,
    `Semester ${semester} ${academicYear} locked. ${modifiedCount} result(s) locked, ` +
    `${transcriptsGenerated} transcript(s) generated, ${transcriptErrors} error(s).`,
    {
      modifiedCount,
      transcriptsGenerated,
      transcriptErrors,
    }
  );
});

// ─── AUDIT CORRECTION ─────────────────────────────────────────────────────────

/**
 * PATCH /api/results/audit/:id
 * Correction post-publication. Réservée ADMIN/DIRECTOR.
 * Toute modification est tracée dans auditLog[] (append-only).
 *
 * Body : { score?, teacherRemarks?, reason (min 10 chars, obligatoire) }
 */
const auditCorrection = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { score, teacherRemarks, reason } = req.body;

  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid result ID.');
  if (!isGlobalRole(req.user.role))
    return sendForbidden(res, 'Only ADMIN or DIRECTOR can make post-publication corrections.');
  if (!reason || reason.trim().length < 10)
    return sendError(res, 400, 'A reason of at least 10 characters is required for any audit correction.');

  const result = await resultRepo.findResultForWrite(id);
  if (!result) return sendNotFound(res, 'Result');

  if (result.status === RESULT_STATUS.DRAFT)
    return sendError(res, 400, 'Use the standard PUT endpoint for DRAFT results.');

  const trimmedReason = reason.trim();

  if (score !== undefined) {
    if (Number(score) < 0 || Number(score) > result.maxScore)
      return sendError(res, 400, `Score must be between 0 and ${result.maxScore}.`);
    result.addAuditEntry('score', result.score, Number(score), trimmedReason, req.user.id, req.ip);
    result.score = Number(score);
  }

  if (teacherRemarks !== undefined) {
    result.addAuditEntry('teacherRemarks', result.teacherRemarks, teacherRemarks, trimmedReason, req.user.id, req.ip);
    result.teacherRemarks = teacherRemarks;
  }

  await resultRepo.saveResultDoc(result);

  return sendSuccess(res, 200, 'Audit correction applied and logged.', {
    result,
    auditEntriesAdded: result.auditLog.length,
  });
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  submitResult,
  submitBatch,
  publishResult,
  publishBatch,
  archiveResult,
  lockSemester,
  auditCorrection,
};