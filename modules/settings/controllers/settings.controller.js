/**
 * Settings Controller — UserPreferences CRUD
 *
 * Endpoints:
 *   GET    /api/settings         → getSettings   (full UserPreferences)
 *   PATCH  /api/settings         → updateSettings (partial update)
 *   POST   /api/settings         → upsertSettings (migration safety net)
 *   GET    /api/settings/language → getLanguage   (shortcut)
 */

const UserPreferences = require('../models/userPreferences.model');
// Require paresseux : settings est dans la cloture statique de campus
const getCampusDefaults = (...args) => require('../../campus').service.getCampusDefaults(...args);

const {
  sendSuccess,
  sendError,
  asyncHandler,
} = require('../../../shared/utils/response-helpers');

const SUPPORTED_LANGUAGES  = UserPreferences.schema.statics.SUPPORTED_LANGUAGES  || ['en', 'fr', 'es', 'ar', 'zh-CN', 'de'];
const SUPPORTED_TIMEZONES  = require('../models/timezone-whitelist');
const SUPPORTED_GRADE_FMTS = ['FRACTION', 'PERCENT', 'LETTER', 'GPA'];
const SUPPORTED_DATE_FMTS  = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

// ── Helper: build campus defaults for a new UserPreferences doc ───────────────
async function buildDefaultsFromCampus(campusId) {
  try {
    if (!campusId) return {};
    const campus = await getCampusDefaults(campusId);
    if (!campus) return {};
    return {
      preferredLanguage: campus.defaultLanguage || 'en',
      timezone:          campus.defaultTimezone  || 'UTC',
      gradeFormat:       campus.defaultGradeFormat || 'FRACTION',
    };
  } catch {
    return {};
  }
}

// ── Helper: derive campusId + userModel from JWT payload ──────────────────────
function extractIdentity(req) {
  const { id, role, campusId } = req.user ?? {};
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
  return {
    userId:    id,
    userModel: MODEL_MAP[role] || 'Admin',
    campusId:  campusId || null,
  };
}

// ── GET /api/settings ─────────────────────────────────────────────────────────
const getSettings = asyncHandler(async (req, res) => {
  const { userId, userModel, campusId } = extractIdentity(req);

  let prefs = await UserPreferences.findOne({ userId });

  if (!prefs) {
    // Lazy upsert: first access creates the doc with campus defaults
    const defaults = await buildDefaultsFromCampus(campusId);
    prefs = await UserPreferences.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, userModel, campusId, ...defaults } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  return sendSuccess(res, 200, 'Settings retrieved.', prefs);
});

// ── PATCH /api/settings ───────────────────────────────────────────────────────
const updateSettings = asyncHandler(async (req, res) => {
  const { userId, userModel, campusId } = extractIdentity(req);
  const { preferredLanguage, preferredLocale, timezone, gradeFormat, dateFormat, theme } = req.body ?? {};

  // Validate whitelisted enums
  if (preferredLanguage && !SUPPORTED_LANGUAGES.includes(preferredLanguage)) {
    return sendError(res, 400, `Unsupported language: ${preferredLanguage}`);
  }
  if (timezone && !SUPPORTED_TIMEZONES.includes(timezone)) {
    return sendError(res, 400, `Unsupported timezone: ${timezone}`);
  }
  if (gradeFormat && !SUPPORTED_GRADE_FMTS.includes(gradeFormat)) {
    return sendError(res, 400, `Unsupported gradeFormat: ${gradeFormat}`);
  }
  if (dateFormat && !SUPPORTED_DATE_FMTS.includes(dateFormat)) {
    return sendError(res, 400, `Unsupported dateFormat: ${dateFormat}`);
  }

  const update = {};
  if (preferredLanguage !== undefined) update.preferredLanguage = preferredLanguage;
  if (preferredLocale   !== undefined) update.preferredLocale   = preferredLocale;
  if (timezone          !== undefined) update.timezone          = timezone;
  if (gradeFormat       !== undefined) update.gradeFormat       = gradeFormat;
  if (dateFormat        !== undefined) update.dateFormat        = dateFormat;
  if (theme             !== undefined) update.theme             = theme;

  if (!Object.keys(update).length) {
    return sendError(res, 400, 'No valid fields to update.');
  }

  const defaults = await buildDefaultsFromCampus(campusId);
  // Exclude from $setOnInsert any field already in $set — MongoDB rejects a
  // path that appears in both operators when the upsert creates a new document.
  const insertDefaults = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !(key in update))
  );
  const prefs = await UserPreferences.findOneAndUpdate(
    { userId },
    {
      $set: update,
      $setOnInsert: { userId, userModel, campusId, ...insertDefaults },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return sendSuccess(res, 200, 'Settings updated.', prefs);
});

// ── POST /api/settings  (upsert — migration safety net) ──────────────────────
const upsertSettings = asyncHandler(async (req, res) => {
  const { userId, userModel, campusId } = extractIdentity(req);
  const defaults = await buildDefaultsFromCampus(campusId);

  const prefs = await UserPreferences.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, userModel, campusId, ...defaults } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return sendSuccess(res, 200, 'Settings upserted.', prefs);
});

// ── GET /api/settings/language  (shortcut) ────────────────────────────────────
const getLanguage = asyncHandler(async (req, res) => {
  const { userId, userModel, campusId } = extractIdentity(req);

  let prefs = await UserPreferences.findOne({ userId }).select('preferredLanguage');

  if (!prefs) {
    const defaults = await buildDefaultsFromCampus(campusId);
    prefs = await UserPreferences.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, userModel, campusId, ...defaults } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  return sendSuccess(res, 200, 'Language retrieved.', {
    preferredLanguage: prefs.preferredLanguage || 'en',
  });
});

module.exports = { getSettings, updateSettings, upsertSettings, getLanguage };
