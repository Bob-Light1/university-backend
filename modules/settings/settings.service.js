/**
 * @file settings.service.js
 * API publique du module settings (préférences utilisateur, timezones).
 */

const SUPPORTED_TIMEZONES = require('./models/timezone-whitelist');
const UserPreferences     = require('./models/userPreferences.model');
// Shim racine — résorption en C5 (chantier 20b)
const Campus              = require('../../models/campus.model');

const MODEL_MAP = {
  ADMIN:          'Admin',
  DIRECTOR:       'Director',
  CAMPUS_MANAGER: 'Campus',
  TEACHER:        'Teacher',
  STUDENT:        'Student',
  PARENT:         'Parent',
  MENTOR:         'Mentor',
  STAFF:          'Staff',
  PARTNER:        'Partner',
};

/**
 * Lazy-upsert UserPreferences at login time.
 * Returns { preferredLanguage, timezone } to include in the login response.
 * Never throws — falls back to safe defaults so login is never blocked.
 * Consommé par les 8 controllers d'authentification (admin, staff, teacher,
 * student, mentor, parent, partner, campus).
 */
async function getLoginPrefs(userId, role, campusId = null) {
  try {
    const userModel = MODEL_MAP[role] || 'Admin';

    // Campus-level defaults (best-effort)
    let campusDefaults = {};
    if (campusId) {
      const campus = await Campus.findById(campusId).select(
        'defaultLanguage defaultTimezone defaultGradeFormat'
      );
      if (campus) {
        campusDefaults = {
          preferredLanguage: campus.defaultLanguage  || 'en',
          timezone:          campus.defaultTimezone  || 'UTC',
          gradeFormat:       campus.defaultGradeFormat || 'FRACTION',
        };
      }
    }

    const prefs = await UserPreferences.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, userModel, campusId, ...campusDefaults } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return {
      preferredLanguage: prefs.preferredLanguage || 'en',
      timezone:          prefs.timezone          || 'UTC',
    };
  } catch (err) {
    console.error('[login-prefs] getLoginPrefs error (non-fatal):', err.message);
    return { preferredLanguage: 'en', timezone: 'UTC' };
  }
}

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
  getLoginPrefs,
};
