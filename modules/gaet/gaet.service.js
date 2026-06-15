/**
 * @file gaet.service.js
 * API publique du module GAET pour le reste de l'application.
 * (Règle d'architecture : les autres modules / server.js ne touchent JAMAIS
 *  directement aux models de ce module — voir MODULAR_MONOLITH_MIGRATION.md §3.)
 *
 * Toute la persistance passe par gaet.repository (étape 0 pré-Postgres).
 */

const gaetRepo = require('./gaet.repository');

const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Récupère les jobs de génération zombies (laissés en GENERATING après un
 * crash/restart du serveur) et les passe en FAILED pour que le campus manager
 * puisse relancer proprement. Appelé par server.js au démarrage, une fois la
 * connexion MongoDB établie.
 *
 * @returns {Promise<number>} nombre de jobs récupérés
 */
function recoverZombieJobs() {
  return gaetRepo.recoverZombies(ZOMBIE_THRESHOLD_MS);
}

module.exports = {
  recoverZombieJobs,
};
