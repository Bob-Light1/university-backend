'use strict';

/**
 * @file result.helpers.js
 * @description Helpers partagés et validation commune pour les controllers results.
 *
 *  Ce fichier est importé par :
 *  • result.crud.controller.js
 *  • result.workflow.controller.js
 *  • result.analytics.controller.js
 *
 *  Il centralise :
 *  • Les guards de rôle (isGlobalRole, isManagerRole)
 *  • La résolution du campus depuis req
 *  • La validation des champs communs (ID, enums, academicYear)
 *  • Les helpers de pagination
 */

const mongoose = require('mongoose');
const { buildCampusFilter, isValidObjectId } = require('../../utils/validationHelpers');
const { sendError, sendForbidden } = require('../../utils/responseHelpers');
const { RESULT_STATUS, EVALUATION_TYPE, SEMESTER } = require('../../models/result.model');

// ─── GUARDS DE RÔLE ───────────────────────────────────────────────────────────

/** true pour ADMIN et DIRECTOR — accès cross-campus et override des verrous */
const isGlobalRole  = (role) => role === 'ADMIN' || role === 'DIRECTOR';

/** true pour ADMIN, DIRECTOR et CAMPUS_MANAGER */
const isManagerRole = (role) => isGlobalRole(role) || role === 'CAMPUS_MANAGER';

// ─── RÉSOLUTION DU CAMPUS ─────────────────────────────────────────────────────

/**
 * Returns the schoolCampus MongoDB filter to be applied on every Result query.
 *
 * Wraps buildCampusFilter from validationHelpers and converts a missing-campusId
 * breach into an Express-compatible 403 response so no data leaks silently.
 *
 * Usage inside async controllers:
 *   const filter = getCampusFilter(req, res);
 *   if (!filter) return; // response already sent
 *
 * @param {Object} req - Express request (req.user must be populated by authenticate)
 * @param {Object} res - Express response (used only when an error must be sent)
 * @returns {Object|null} MongoDB filter, or null when a 403 has been sent
 */
const getCampusFilter = (req, res) => {
  try {
    // Only ADMIN/DIRECTOR may pass an explicit campusId override via query param.
    // For all other roles buildCampusFilter ignores the second argument and uses
    // req.user.campusId exclusively — preventing cross-campus query injection.
    return buildCampusFilter(req.user, req.query.campusId || null);
  } catch (err) {
    // buildCampusFilter throws when a non-global role has no valid campusId.
    // Log the anomaly and return a 403 instead of leaking all campus data.
    console.error('[CampusIsolation] result.helper – getCampusFilter breach:', err.message);
    if (res && !res.headersSent) {
      sendForbidden(res, 'Campus information is missing from your session. Please log in again.');
    }
    return null;
  }
};

/**
 * Résout le campusId effectif depuis req.user + body optionnel.
 * ADMIN/DIRECTOR peuvent spécifier un campus externe ; les autres sont limités
 * à leur propre campus.
 *
 * @param {Object} req
 * @param {string} [campusFromBody] - Valeur optionnelle venue du body
 * @returns {string|null}  campusId résolu, ou null si absent
 */
const resolveCampusId = (req, campusFromBody) => {
  const { role, campusId: userCampusId } = req.user;
  return isGlobalRole(role)
    ? (campusFromBody || userCampusId || null)
    : userCampusId || null;
};

// ─── VALIDATION COMMUNE ───────────────────────────────────────────────────────

/**
 * Valide les champs contextuels communs à toutes les créations de résultats.
 * Retourne null si tout est valide, ou une chaîne d'erreur.
 *
 * @param {Object} fields - { evaluationType, semester, academicYear, score, maxScore }
 * @returns {string|null}
 */
const validateResultContext = ({ evaluationType, semester, academicYear, score, maxScore }) => {
  if (!Object.values(EVALUATION_TYPE).includes(evaluationType))
    return `Invalid evaluationType. Must be: ${Object.values(EVALUATION_TYPE).join(', ')}.`;
  if (!Object.values(SEMESTER).includes(semester))
    return `Invalid semester. Must be: ${Object.values(SEMESTER).join(', ')}.`;
  if (!/^\d{4}-\d{4}$/.test(academicYear))
    return 'academicYear must be YYYY-YYYY (ex. 2024-2025).';
  if (score == null || maxScore == null)
    return 'score and maxScore are required.';
  if (Number(score) < 0 || Number(score) > Number(maxScore))
    return `Score (${score}) must be between 0 and maxScore (${maxScore}).`;
  return null;
};

/**
 * Valide les ObjectId obligatoires d'un résultat.
 * Retourne null si tous sont valides, ou une chaîne d'erreur.
 *
 * @param {Object} ids - { student, classId, subject, teacher }
 * @returns {string|null}
 */
const validateResultIds = ({ student, classId, subject, teacher }) => {
  if (!isValidObjectId(student))  return 'Invalid student ID.';
  if (!isValidObjectId(classId))  return 'Invalid class ID.';
  if (!isValidObjectId(subject))  return 'Invalid subject ID.';
  if (!isValidObjectId(teacher))  return 'Invalid teacher ID.';
  return null;
};

/**
 * Vérifie qu'une transition d'état est autorisée.
 *
 * Transitions valides :
 *  DRAFT      → SUBMITTED  (enseignant)
 *  SUBMITTED  → PUBLISHED  (manager)
 *  SUBMITTED  → DRAFT      (renvoi en correction par manager)
 *  PUBLISHED  → ARCHIVED   (manager)
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
const isValidTransition = (from, to) => {
  const allowed = {
    [RESULT_STATUS.DRAFT]:     [RESULT_STATUS.SUBMITTED],
    [RESULT_STATUS.SUBMITTED]: [RESULT_STATUS.PUBLISHED, RESULT_STATUS.DRAFT],
    [RESULT_STATUS.PUBLISHED]: [RESULT_STATUS.ARCHIVED],
    [RESULT_STATUS.ARCHIVED]:  [],
  };
  return (allowed[from] || []).includes(to);
};

// ─── HELPERS DE PAGINATION ────────────────────────────────────────────────────

/**
 * Parse un paramètre de query en entier positif avec fallback.
 * @param {*}      val       - Valeur brute (string de query)
 * @param {number} fallback  - Valeur par défaut
 * @returns {number}
 */
const parsePositiveInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ─── POPULATE STANDARDS ───────────────────────────────────────────────────────

/**
 * Options de populate réutilisées dans plusieurs endpoints.
 * Centralisées ici pour éviter la duplication et faciliter la maintenance.
 */
const RESULT_POPULATE = Object.freeze({
  LIST: [
    { path: 'student', select: 'firstName lastName matricule' },
    { path: 'subject', select: 'subject_name subject_code coefficient' },
    { path: 'teacher', select: 'firstName lastName email' },
    { path: 'class',   select: 'className' },
  ],
  DETAIL: [
    { path: 'student',      select: 'firstName lastName matricule email' },
    { path: 'subject',      select: 'subject_name subject_code coefficient' },
    { path: 'teacher',      select: 'firstName lastName email' },
    { path: 'class',        select: 'className' },
    { path: 'classManager', select: 'firstName lastName email' },
    { path: 'gradingScale', select: 'name system maxScore passMark bands' },
  ],
});

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Guards de rôle
  isGlobalRole,
  isManagerRole,
  // Campus
  getCampusFilter,
  resolveCampusId,
  // Validation
  validateResultContext,
  validateResultIds,
  isValidTransition,
  // Pagination
  parsePositiveInt,
  // Populate
  RESULT_POPULATE,
};