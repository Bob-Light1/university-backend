/**
 * @file mentor.service.js
 * API publique du module mentor pour les autres modules / controllers.
 * (Les autres domaines ne touchent JAMAIS directement mentor.model — §3 du guide.)
 */

const Mentor = require('./mentor.model');

/**
 * Statistiques mentors d'un campus pour le dashboard campus.
 * (Consommé par campus.controller — comportement identique aux 3 requêtes
 *  qu'il exécutait directement sur le model.)
 *
 * @param {string|ObjectId} campusId  - id campus (filtre countDocuments)
 * @param {ObjectId}        campusOid - id campus en ObjectId (pipeline aggregate)
 * @returns {Promise<{ total:number, active:number, studentsAssigned:number }>}
 */
async function getCampusStats(campusId, campusOid) {
  const [total, active, studentsAgg] = await Promise.all([
    Mentor.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
    Mentor.countDocuments({ schoolCampus: campusId, status: 'active' }),
    Mentor.aggregate([
      { $match: { schoolCampus: campusOid, status: { $ne: 'archived' } } },
      { $group: { _id: null, total: { $sum: { $size: '$students' } } } },
    ]),
  ]);
  return {
    total,
    active,
    studentsAssigned: studentsAgg[0]?.total ?? 0,
  };
}

/**
 * Liste paginée des mentors d'un campus (recherche + filtre statut).
 * (Consommé par campus.controller GET /api/campus/:campusId/mentors —
 *  comportement identique à la requête qu'il exécutait directement.)
 *
 * @param {object} opts
 * @param {string} opts.campusId
 * @param {number} opts.page
 * @param {number} opts.limit
 * @param {string} [opts.search]      - regex déjà échappée par l'appelant
 * @param {string} [opts.status]
 * @param {function} opts.escapeRegex - helper d'échappement fourni par l'appelant
 * @returns {Promise<{ mentors:object[], total:number }>}
 */
async function listByCampus({ campusId, page, limit, search, status, escapeRegex }) {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  else filter.status = { $ne: 'archived' };

  if (search) {
    filter.$or = [
      { firstName:      { $regex: escapeRegex(search), $options: 'i' } },
      { lastName:       { $regex: escapeRegex(search), $options: 'i' } },
      { email:          { $regex: escapeRegex(search), $options: 'i' } },
      { phone:          { $regex: escapeRegex(search), $options: 'i' } },
      { specialization: { $regex: escapeRegex(search), $options: 'i' } },
      { matricule:      { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [mentors, total] = await Promise.all([
    Mentor.find(filter)
      .populate('assignedStudents', 'firstName lastName matricule')
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Mentor.countDocuments(filter),
  ]);

  return { mentors, total };
}

module.exports = {
  getCampusStats,
  listByCampus,
};
