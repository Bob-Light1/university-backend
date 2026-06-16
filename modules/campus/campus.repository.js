'use strict';

/**
 * @file campus.repository.js — couche de persistance du domaine campus.
 *
 * SEUL fichier du module autorisé à interroger le model Campus directement
 * (controller + service inter-modules). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * NB : campus.config fournit encore Model: Campus au GenericEntityController
 * partagé (couche partagée opérant sur un Model, hors périmètre du repository par
 * module). Le model n'a pas de hook pre/post (seulement des méthodes d'instance
 * canAddX et la statique findActive).
 */

const Campus = require('./campus.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// ── Controller ────────────────────────────────────────────────────────────────

/** Crée un campus. @returns {Promise<Document>} (passé à GenericEntityController.afterCreate) */
const create = (data) => Campus.create(data);

/** Recherche par email (contrôle d'unicité à la création). */
const findByEmail = (email) => Campus.findOne({ email }).lean();

/** Recherche par email AVEC le hash (login). */
const findByEmailWithPassword = (email) =>
  Campus.findOne({ email }).select('+password').lean();

/** Met à jour lastLogin (fire-and-forget). */
const touchLastLogin = (id) =>
  Campus.updateOne({ _id: id }, { $set: { lastLogin: new Date() } });

/**
 * Liste paginée (sans mot de passe). Filtres status/city/recherche.
 * @returns {Promise<{data, total}>}
 */
const paginate = async ({ status, city, search, skip, limit }) => {
  const filter = {};
  if (status) filter.status = status;
  if (city) filter['location.city'] = { $regex: escapeRegex(city), $options: 'i' };
  if (search) {
    const rx = (f) => ({ [f]: { $regex: escapeRegex(search), $options: 'i' } });
    filter.$or = [rx('campus_name'), rx('manager_name'), rx('email'), rx('campus_number')];
  }

  const [data, total] = await Promise.all([
    Campus.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campus.countDocuments(filter),
  ]);
  return { data, total };
};

/** Lecture sans mot de passe (getById / dashboard). */
const findByIdSafe = (id) => Campus.findById(id).select('-password').lean();

/** Lecture avec le hash (changement de mot de passe). */
const findByIdWithPassword = (id) => Campus.findById(id).select('+password').lean();

/** Met à jour le mot de passe (déjà hashé). */
const updatePassword = (id, hashedPassword) =>
  Campus.findByIdAndUpdate(id, { password: hashedPassword });

/** Met à jour les préférences par défaut et renvoie la projection associée. */
const updateDefaults = (id, update) =>
  Campus.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true })
    .select('defaultLanguage defaultTimezone defaultGradeFormat campus_name').lean();

// ── Service inter-modules (ancien campus.service) ─────────────────────────────

const getCampusName = (campusId) =>
  Campus.findById(campusId).select('campus_name').lean();

const getCampusForPdf = (campusId) =>
  Campus.findById(campusId).select('campus_name campus_image location').lean();

const getCampusStorageInfo = (campusId) =>
  Campus.findById(campusId).select('features campus_name').lean();

const getCampusDefaults = (campusId) =>
  Campus.findById(campusId).select('defaultLanguage defaultTimezone defaultGradeFormat').lean();

/** Document Mongoose complet (méthodes d'instance — ex. campus.canAddClass()). */
const getCampusDocById = (campusId) => Campus.findById(campusId);

const getCampusCommissionConfig = (campusId) =>
  Campus.findById(campusId).select('commissionConfig').lean();

/** Config de commission + nom du campus (back-office partner.commission). */
const getCampusCommissionConfigWithName = (campusId) =>
  Campus.findById(campusId).select('commissionConfig campus_name').lean();

/**
 * Met à jour la config de commission embarquée (back-office partner.commission).
 * @param {Object} cfg — { ruleType, fixedAmount, percentage, defaultCurrency, updatedBy }
 */
const setCampusCommissionConfig = (campusId, cfg) =>
  Campus.findByIdAndUpdate(
    campusId,
    { $set: {
      'commissionConfig.ruleType':        cfg.ruleType,
      'commissionConfig.fixedAmount':     cfg.fixedAmount,
      'commissionConfig.percentage':      cfg.percentage,
      'commissionConfig.defaultCurrency': cfg.defaultCurrency,
      'commissionConfig.updatedBy':       cfg.updatedBy,
      'commissionConfig.updatedAt':       new Date(),
    } },
    { new: true, runValidators: true }
  ).select('commissionConfig campus_name').lean();

const getActiveCampusBySlug = (campusSlug, select = '_id') =>
  Campus.findOne({ campusSlug, status: 'active' }).select(select).lean();

const getActiveCampusById = (campusId, select) =>
  Campus.findOne({ _id: campusId, status: 'active' }).select(select).lean();

const listActivePublicCampuses = (select) =>
  Campus.find({ status: 'active', campusSlug: { $ne: null } })
    .select(select).sort({ campus_name: 1 }).lean();

module.exports = {
  // controller
  create,
  findByEmail,
  findByEmailWithPassword,
  touchLastLogin,
  paginate,
  findByIdSafe,
  findByIdWithPassword,
  updatePassword,
  updateDefaults,
  // service
  getCampusName,
  getCampusForPdf,
  getCampusStorageInfo,
  getCampusDefaults,
  getCampusDocById,
  getCampusCommissionConfig,
  getCampusCommissionConfigWithName,
  setCampusCommissionConfig,
  getActiveCampusBySlug,
  getActiveCampusById,
  listActivePublicCampuses,
};
