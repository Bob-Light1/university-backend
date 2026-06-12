/**
 * @file staff.service.js
 * API publique du module staff pour les autres modules / controllers.
 * (Les autres domaines ne touchent JAMAIS directement staff.model — §3 du guide.)
 */

const Staff = require('./models/staff.model');

/**
 * Statistiques staff d'un campus pour le dashboard campus.
 * (Consommé par campus.controller — comportement identique aux 3 requêtes
 *  qu'il exécutait directement sur le model.)
 *
 * @param {string|ObjectId} campusId
 * @returns {Promise<{ total:number, active:number, withRole:number }>}
 */
async function getCampusStats(campusId) {
  const [total, active, withRole] = await Promise.all([
    Staff.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
    Staff.countDocuments({ schoolCampus: campusId, status: 'active' }),
    Staff.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' }, subRole: { $exists: true, $ne: null } }),
  ]);
  return { total, active, withRole };
}

module.exports = {
  getCampusStats,
};
