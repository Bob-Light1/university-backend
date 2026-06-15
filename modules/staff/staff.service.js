/**
 * @file staff.service.js
 * API publique du module staff pour les autres modules / controllers.
 * (Les autres domaines ne touchent JAMAIS directement staff.model — §3 du guide.)
 * Toute la persistance passe par staff.repository (étape 0 pré-Postgres).
 */

const staffRepo = require('./staff.repository');

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
    staffRepo.countByCampus(campusId, { status: { $ne: 'archived' } }),
    staffRepo.countByCampus(campusId, { status: 'active' }),
    staffRepo.countByCampus(campusId, { status: { $ne: 'archived' }, subRole: { $exists: true, $ne: null } }),
  ]);
  return { total, active, withRole };
}

module.exports = {
  getCampusStats,
};
