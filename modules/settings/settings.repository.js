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
// `runValidators` enforces enum/format constraints on update — findOneAndUpdate
// skips validators by default, which would otherwise let an invalid `theme`
// or `preferredLocale` slip through (the controller validates them too, but
// this is the model-level last line of defense).
const UPSERT_OPTS = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true };

/**
 * Runs an upsert, transparently absorbing the unique-index race.
 *
 * `findOneAndUpdate({ upsert: true })` is NOT atomic against the unique
 * `userId` index: when several first-access requests for the same user fire
 * concurrently (login + GET /settings + GET /settings/language), two of them
 * can both miss the document and race to insert, and the loser throws E11000.
 * The global error handler would surface that as a misleading 409 on a plain
 * read. We retry once — by then the document exists, so the update path is
 * taken and no insert is attempted.
 * @param {() => Promise<Object>} run
 * @returns {Promise<Object>}
 */
const withDuplicateRetry = async (run) => {
  try {
    return await run();
  } catch (err) {
    if (err && err.code === 11000) return run();
    throw err;
  }
};

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
  withDuplicateRetry(() =>
    UserPreferences.findOneAndUpdate({ userId }, { $setOnInsert: insertDoc }, UPSERT_OPTS).lean());

/**
 * Updates fields in `set`; on creation, also applies `insertDoc`
 * ($setOnInsert). The caller guarantees that `set` and `insertDoc` share
 * no keys (MongoDB constraint).
 * @returns {Promise<Object>}
 */
const upsertWithSet = (userId, set, insertDoc) =>
  withDuplicateRetry(() =>
    UserPreferences.findOneAndUpdate(
      { userId },
      { $set: set, $setOnInsert: insertDoc },
      UPSERT_OPTS,
    ).lean());

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
