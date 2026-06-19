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

// Common options for "lazy" preference upserts.
const UPSERT_OPTS = { upsert: true, new: true, setDefaultsOnInsert: true };

/** Full preferences for a user (read). @returns {Promise<Object|null>} */
const findByUserId = (userId) => UserPreferences.findOne({ userId }).lean();

/** Preferred language only (projected read). @returns {Promise<{preferredLanguage}|null>} */
const findLanguageByUserId = (userId) =>
  UserPreferences.findOne({ userId }).select('preferredLanguage').lean();

/** Preferred languages for a batch of users (projected userId+language). @returns {Promise<Array<{userId, preferredLanguage}>>} */
const findLanguagesByUserIds = (userIds) =>
  UserPreferences.find({ userId: { $in: userIds } }).select('userId preferredLanguage').lean();

/**
 * Lazy upsert: creates the document with `insertDoc` if it does not exist,
 * otherwise returns the existing document unchanged. (login, first access, migration net.)
 * @returns {Promise<Object>}
 */
const upsertOnInsert = (userId, insertDoc) =>
  UserPreferences.findOneAndUpdate({ userId }, { $setOnInsert: insertDoc }, UPSERT_OPTS).lean();

/**
 * Updates fields in `set`; on creation, also applies `insertDoc`
 * ($setOnInsert). The caller guarantees that `set` and `insertDoc` share
 * no keys (MongoDB constraint).
 * @returns {Promise<Object>}
 */
const upsertWithSet = (userId, set, insertDoc) =>
  UserPreferences.findOneAndUpdate(
    { userId },
    { $set: set, $setOnInsert: insertDoc },
    UPSERT_OPTS,
  ).lean();

/** Whitelist of supported languages (schema static + fallback to the single source). */
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
