'use strict';

/**
 * @file campus.service.js — API inter-modules du domaine campus.
 *
 * Exposé :
 *   - getCampusName             : nom du campus (en-têtes de documents).
 *   - getCampusForPdf           : nom + logo + localisation (rendu PDF académique).
 *   - getCampusDefaults         : langue/timezone/format de note par défaut (settings).
 *   - getCampusDocById          : document Mongoose complet (méthodes d'instance — class.canAddClass).
 *   - getCampusCommissionConfig : config de commission (partner.lead).
 *   - getActiveCampusBySlug     : résolution portail public par slug (status actif).
 *   - getActiveCampusById       : résolution portail public par _id (status actif).
 *   - listActivePublicCampuses  : liste des campus publics (sélecteur de portail).
 *
 * NB : les consommateurs requièrent cette façade en require PARESSEUX
 * (`require('../../campus').service` à l'appel) car le module campus est un hub
 * qui requiert lui-même de nombreux modules (settings, teacher, student, class,
 * finance, department, staff, mentor) — un require statique créerait des cycles.
 */

const Campus = require('./campus.model');

/**
 * Nom d'un campus (en-tête de document).
 * @param {string|ObjectId} campusId
 * @returns {Promise<{campus_name}|null>}
 */
const getCampusName = (campusId) =>
  Campus.findById(campusId).select('campus_name').lean();

/**
 * Nom + image + localisation d'un campus (branding des PDF académiques).
 * @param {string|ObjectId} campusId
 * @returns {Promise<{campus_name, campus_image, location}|null>}
 */
const getCampusForPdf = (campusId) =>
  Campus.findById(campusId).select('campus_name campus_image location').lean();

/**
 * Quota de stockage documentaire d'un campus (features + nom).
 * @param {string|ObjectId} campusId
 * @returns {Promise<{features, campus_name}|null>}
 */
const getCampusStorageInfo = (campusId) =>
  Campus.findById(campusId).select('features campus_name').lean();

/**
 * Préférences par défaut d'un campus (langue/timezone/format de note).
 * @param {string|ObjectId} campusId
 * @returns {Promise<{defaultLanguage, defaultTimezone, defaultGradeFormat}|null>}
 */
const getCampusDefaults = (campusId) =>
  Campus.findById(campusId)
    .select('defaultLanguage defaultTimezone defaultGradeFormat')
    .lean();

/**
 * Document Mongoose complet d'un campus (nécessaire pour les méthodes
 * d'instance, ex. campus.canAddClass()).
 * @param {string|ObjectId} campusId
 * @returns {Promise<Document|null>}
 */
const getCampusDocById = (campusId) => Campus.findById(campusId);

/**
 * Config de commission d'un campus (calcul partenaire).
 * @param {string|ObjectId} campusId
 * @returns {Promise<{commissionConfig}|null>}
 */
const getCampusCommissionConfig = (campusId) =>
  Campus.findById(campusId).select('commissionConfig').lean();

/**
 * Résolution d'un campus actif par slug (portail public).
 * Le slug doit être normalisé par l'appelant (comportement préservé : certains
 * appelants normalisent .toLowerCase().trim(), d'autres non).
 * @param {string} campusSlug
 * @param {string} [select='_id']
 * @returns {Promise<Object|null>}
 */
const getActiveCampusBySlug = (campusSlug, select = '_id') =>
  Campus.findOne({ campusSlug, status: 'active' }).select(select).lean();

/**
 * Résolution d'un campus actif par _id (portail public, ex. via partenaire).
 * @param {string|ObjectId} campusId
 * @param {string} select
 * @returns {Promise<Object|null>}
 */
const getActiveCampusById = (campusId, select) =>
  Campus.findOne({ _id: campusId, status: 'active' }).select(select).lean();

/**
 * Liste des campus publics (actifs et dotés d'un campusSlug), triés par nom.
 * @param {string} select
 * @returns {Promise<Array>}
 */
const listActivePublicCampuses = (select) =>
  Campus.find({ status: 'active', campusSlug: { $ne: null } })
    .select(select)
    .sort({ campus_name: 1 })
    .lean();

module.exports = {
  getCampusName,
  getCampusForPdf,
  getCampusStorageInfo,
  getCampusDefaults,
  getCampusDocById,
  getCampusCommissionConfig,
  getActiveCampusBySlug,
  getActiveCampusById,
  listActivePublicCampuses,
};
