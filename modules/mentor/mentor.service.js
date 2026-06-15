/**
 * @file mentor.service.js
 * API publique du module mentor pour les autres modules / controllers.
 * (Les autres domaines ne touchent JAMAIS directement mentor.model — §3 du guide.)
 *
 * Toute la persistance passe par mentor.repository (étape 0 pré-Postgres).
 */

const mentorRepo = require('./mentor.repository');

/**
 * Statistiques mentors d'un campus pour le dashboard campus.
 * (Consommé par campus.controller.)
 *
 * @param {string|ObjectId} campusId  - id campus (filtre countDocuments)
 * @param {ObjectId}        campusOid - id campus en ObjectId (pipeline aggregate)
 * @returns {Promise<{ total:number, active:number, studentsAssigned:number }>}
 */
async function getCampusStats(campusId, campusOid) {
  const [total, active, studentsAgg] = await Promise.all([
    mentorRepo.countByCampus(campusId, { $ne: 'archived' }),
    mentorRepo.countByCampus(campusId, 'active'),
    mentorRepo.aggregateAssignedStudents(campusOid),
  ]);
  return {
    total,
    active,
    studentsAssigned: studentsAgg[0]?.total ?? 0,
  };
}

/**
 * Liste paginée des mentors d'un campus (recherche + filtre statut).
 * (Consommé par campus.controller GET /api/campus/:campusId/mentors.)
 * Le paramètre `escapeRegex` est conservé pour compat d'appel mais ignoré —
 * l'échappement est désormais fait dans le repository.
 *
 * @returns {Promise<{ mentors:object[], total:number }>}
 */
function listByCampus({ campusId, page, limit, search, status }) {
  const skip = (Number(page) - 1) * Number(limit);
  return mentorRepo.listForCampusService({ campusId, status, search, skip, limit: Number(limit) });
}

module.exports = {
  getCampusStats,
  listByCampus,
};
