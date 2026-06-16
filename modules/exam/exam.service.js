'use strict';

/**
 * @file exam.service.js — API inter-modules du domaine exam (façade).
 *
 * Consommateurs actuels :
 *   - server.js : runAntiCheatJob (cron nocturne d'analyse anti-triche)
 *   - staff : listCampusExaminations (GET /api/staff/me/examinations)
 *   - student : getUpcomingExamsForStudent (dashboard étudiant)
 *   - teacher : countPendingGrading (dashboard enseignant)
 */

const { runAntiCheatJob } = require('./exam-anticheat.cron');
const repo                = require('./exam.repository');

/**
 * Liste paginée des sessions d'examen d'un campus (lecture seule).
 * Par défaut, exclut les sessions CANCELLED.
 * @param {Object} p
 * @param {ObjectId|string} p.campusId
 * @param {number} [p.page=1]
 * @param {number} [p.limit=20]
 * @param {string} [p.academicYear]
 * @param {string} [p.semester]
 * @param {string} [p.status]
 * @returns {Promise<{docs: Object[], total: number}>}
 */
const listCampusExaminations = async ({ campusId, page = 1, limit = 20, academicYear, semester, status }) => {
  const filter = { schoolCampus: campusId };
  filter.status = status || { $ne: 'CANCELLED' };
  if (academicYear) filter.academicYear = academicYear;
  if (semester)     filter.semester     = semester;

  const skip = (Number(page) - 1) * Number(limit);
  return repo.paginateCampusExaminations(filter, { skip, limit: Number(limit) });
};

/**
 * Prochains examens d'un étudiant : inscriptions éligibles dont la session
 * est à venir (SCHEDULED/PUBLISHED/ONGOING), triées par startTime croissant.
 * Note : .sort() Mongoose ne s'applique pas à un champ populé — tri en JS
 * après le populate+match qui élimine les examSession null.
 * @param {ObjectId|string} studentId
 * @param {Object} [opts]
 * @param {number} [opts.limit=5]
 * @returns {Promise<Object[]>}
 */
const getUpcomingExamsForStudent = async (studentId, { limit = 5 } = {}) => {
  const enrollments = await repo.findUpcomingEnrollmentsForStudent(studentId);

  return enrollments
    .filter((e) => e.examSession != null)
    .sort((a, b) => new Date(a.examSession.startTime) - new Date(b.examSession.startTime))
    .slice(0, limit);
};

/**
 * Nombre de copies en attente de correction pour un correcteur.
 * @param {ObjectId|string} graderId
 * @returns {Promise<number>}
 */
const countPendingGrading = (graderId) => repo.countPendingGradingForGrader(graderId);

module.exports = {
  runAntiCheatJob,
  listCampusExaminations,
  getUpcomingExamsForStudent,
  countPendingGrading,
};
