/**
 * @file settings.service.js
 * API publique du module settings (préférences utilisateur, timezones).
 */

const SUPPORTED_TIMEZONES = require('./models/timezone-whitelist');
const UserPreferences     = require('./models/userPreferences.model');

/**
 * Langue préférée d'un utilisateur ('en' par défaut).
 * Le JWT ne transporte jamais preferredLanguage — consommé par exam.delivery
 * pour traduire les questions à la volée.
 * @param {ObjectId|string} userId
 * @returns {Promise<string>}
 */
const getPreferredLanguage = async (userId) => {
  const prefs = await UserPreferences
    .findOne({ userId })
    .select('preferredLanguage')
    .lean();
  return prefs?.preferredLanguage || 'en';
};

module.exports = {
  // Liste blanche des timezones supportées (consommée par campus.controller
  // pour valider PATCH /api/campus/:id/defaults).
  SUPPORTED_TIMEZONES,
  getPreferredLanguage,
};
