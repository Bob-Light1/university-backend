/**
 * Lazy-upsert UserPreferences at login time.
 * Returns { preferredLanguage, timezone } to include in the login response.
 * Never throws — falls back to safe defaults so login is never blocked.
 */
const UserPreferences = require('../models/userPreferences_model');
const Campus          = require('../models/campus.model');

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

module.exports = { getLoginPrefs };
