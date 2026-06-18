'use strict';

/**
 * @file campus.service.js — API inter-modules du domaine campus.
 *
 * Exposé :
 *   - getCampusName             : nom du campus (en-têtes de documents).
 *   - getCampusForPdf           : nom + logo + localisation (rendu PDF académique).
 *   - getCampusDefaults         : langue/timezone/format de note par défaut (settings).
 *   - getCampusNumber           : numéro/préfixe (génération de matricule student, en session).
 *   - getCampusDocById          : document Mongoose complet (méthodes d'instance — class.canAddClass).
 *   - getCampusCommissionConfig : config de commission (partner.lead).
 *   - getCampusCommissionConfigWithName : config + nom du campus (partner.commission).
 *   - setCampusCommissionConfig : mise à jour de la config (partner.commission).
 *   - getActiveCampusBySlug     : résolution portail public par slug (status actif).
 *   - getActiveCampusById       : résolution portail public par _id (status actif).
 *   - listActivePublicCampuses  : liste des campus publics (sélecteur de portail).
 *
 * NB : les consommateurs requièrent cette façade en require PARESSEUX
 * (`require('../../campus').service` à l'appel) car le module campus est un hub
 * qui requiert lui-même de nombreux modules (settings, teacher, student, class,
 * finance, department, staff, mentor) — un require statique créerait des cycles.
 */

const campusRepo = require('./campus.repository');

// Toute la persistance passe par campus.repository (étape 0 pré-Postgres).
const getCampusName             = (campusId) => campusRepo.getCampusName(campusId);
const getCampusForPdf           = (campusId) => campusRepo.getCampusForPdf(campusId);
const getCampusStorageInfo      = (campusId) => campusRepo.getCampusStorageInfo(campusId);
const getCampusDefaults         = (campusId) => campusRepo.getCampusDefaults(campusId);
const getCampusNotificationContact = (campusId) => campusRepo.getCampusNotificationContact(campusId);
const getCampusNumber           = (campusId, opts) => campusRepo.getCampusNumber(campusId, opts);
const getCampusDocById          = (campusId) => campusRepo.getCampusDocById(campusId);
const getCampusCommissionConfig = (campusId) => campusRepo.getCampusCommissionConfig(campusId);
const getCampusCommissionConfigWithName = (campusId) => campusRepo.getCampusCommissionConfigWithName(campusId);
const setCampusCommissionConfig = (campusId, cfg) => campusRepo.setCampusCommissionConfig(campusId, cfg);
const getActiveCampusBySlug     = (slug, select) => campusRepo.getActiveCampusBySlug(slug, select);
const getActiveCampusById       = (campusId, select) => campusRepo.getActiveCampusById(campusId, select);
const listActivePublicCampuses  = (select) => campusRepo.listActivePublicCampuses(select);

module.exports = {
  getCampusName,
  getCampusForPdf,
  getCampusStorageInfo,
  getCampusDefaults,
  getCampusNotificationContact,
  getCampusNumber,
  getCampusDocById,
  getCampusCommissionConfig,
  getCampusCommissionConfigWithName,
  setCampusCommissionConfig,
  getActiveCampusBySlug,
  getActiveCampusById,
  listActivePublicCampuses,
};
