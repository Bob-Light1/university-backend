/**
 * @file gaet.service.js
 * API publique du module GAET pour le reste de l'application.
 * (Règle d'architecture : les autres modules / server.js ne touchent JAMAIS
 *  directement aux models de ce module — voir MODULAR_MONOLITH_MIGRATION.md §3.)
 */

const GaetConstraint  = require('./gaet-constraint.model');
const { GAET_STATUS } = GaetConstraint;

const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Récupère les jobs de génération zombies (laissés en GENERATING après un
 * crash/restart du serveur) et les passe en FAILED pour que le campus manager
 * puisse relancer proprement. Appelé par server.js au démarrage, une fois la
 * connexion MongoDB établie.
 *
 * @returns {Promise<number>} nombre de jobs récupérés
 */
async function recoverZombieJobs() {
  const zombieThreshold = new Date(Date.now() - ZOMBIE_THRESHOLD_MS);
  const result = await GaetConstraint.updateMany(
    { status: GAET_STATUS.GENERATING, generatingStartedAt: { $lt: zombieThreshold } },
    { $set: { status: GAET_STATUS.FAILED, generatingStartedAt: null } }
  );
  return result.modifiedCount;
}

module.exports = {
  recoverZombieJobs,
};
