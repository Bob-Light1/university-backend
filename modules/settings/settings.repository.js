'use strict';

/**
 * @file settings.repository.js — couche de persistance du domaine settings.
 *
 * SEUL fichier du module autorisé à toucher le model UserPreferences.
 * Service et controller appellent ce repository.
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * (timezone-whitelist.js est une constante, pas un model → consommé directement.)
 */

const UserPreferences = require('./models/userPreferences.model');

// Options communes des upserts « paresseux » de préférences.
const UPSERT_OPTS = { upsert: true, new: true, setDefaultsOnInsert: true };

/** Préférences complètes d'un utilisateur (lecture). @returns {Promise<Object|null>} */
const findByUserId = (userId) => UserPreferences.findOne({ userId }).lean();

/** Langue préférée seule (lecture projetée). @returns {Promise<{preferredLanguage}|null>} */
const findLanguageByUserId = (userId) =>
  UserPreferences.findOne({ userId }).select('preferredLanguage').lean();

/** Langues préférées d'un lot d'utilisateurs (projeté userId+langue). @returns {Promise<Array<{userId, preferredLanguage}>>} */
const findLanguagesByUserIds = (userIds) =>
  UserPreferences.find({ userId: { $in: userIds } }).select('userId preferredLanguage').lean();

/**
 * Upsert paresseux : crée le document avec `insertDoc` s'il n'existe pas, sinon
 * renvoie l'existant inchangé. (login, premier accès, filet de migration.)
 * @returns {Promise<Object>}
 */
const upsertOnInsert = (userId, insertDoc) =>
  UserPreferences.findOneAndUpdate({ userId }, { $setOnInsert: insertDoc }, UPSERT_OPTS).lean();

/**
 * Met à jour les champs `set` ; à la création, applique aussi `insertDoc`
 * ($setOnInsert). L'appelant garantit que `set` et `insertDoc` ne partagent
 * aucune clé (contrainte MongoDB).
 * @returns {Promise<Object>}
 */
const upsertWithSet = (userId, set, insertDoc) =>
  UserPreferences.findOneAndUpdate(
    { userId },
    { $set: set, $setOnInsert: insertDoc },
    UPSERT_OPTS,
  ).lean();

/** Liste blanche des langues supportées (statique du schéma + repli sur la source unique). */
const getSupportedLanguages = () =>
  UserPreferences.schema.statics.SUPPORTED_LANGUAGES || require('../../shared/i18n/languages').SUPPORTED_LANGUAGES;

module.exports = {
  findByUserId,
  findLanguageByUserId,
  findLanguagesByUserIds,
  upsertOnInsert,
  upsertWithSet,
  getSupportedLanguages,
};
