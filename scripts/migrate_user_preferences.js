/**
 * One-shot migration — creates a UserPreferences document for every existing
 * user across all 9 models.
 *
 * Usage:
 *   node scripts/migrate_user_preferences.js
 *
 * Safe to re-run: upsert-based (idempotent).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const UserPreferences = require('../models/userPreferences_model');
const Campus = require('../models/campus.model');

// Lazy imports to avoid loading every model at startup
const MODELS = [
  { name: 'Admin',          file: '../models/admin.model',                         role: 'ADMIN',          campusField: null },
  { name: 'Teacher',        file: '../models/teacher-models/teacher.model',        role: 'TEACHER',        campusField: 'schoolCampus' },
  { name: 'Student',        file: '../models/student-models/student.model',        role: 'STUDENT',        campusField: 'schoolCampus' },
  { name: 'Parent',         file: '../models/parent.model',                        role: 'PARENT',         campusField: 'schoolCampus' },
  { name: 'Mentor',         file: '../modules/mentor/mentor.model',                role: 'MENTOR',         campusField: 'schoolCampus' },
  { name: 'Staff',          file: '../modules/staff/models/staff.model',           role: 'STAFF',          campusField: 'schoolCampus' },
  { name: 'Campus',         file: '../models/campus.model',                        role: 'CAMPUS_MANAGER', campusField: '_id' },
  { name: 'Partner',        file: '../models/partner-models/partner.model',        role: 'PARTNER',        campusField: 'schoolCampus' },
];

const MODEL_LABEL = {
  ADMIN: 'Admin', DIRECTOR: 'Director', CAMPUS_MANAGER: 'Campus',
  TEACHER: 'Teacher', STUDENT: 'Student', PARENT: 'Parent',
  MENTOR: 'Mentor', STAFF: 'Staff', PARTNER: 'Partner',
};

// Cache campus defaults to avoid N+1 queries
const campusCache = new Map();
async function getCampusDefaults(campusId) {
  if (!campusId) return {};
  const key = campusId.toString();
  if (campusCache.has(key)) return campusCache.get(key);
  const campus = await Campus.findById(campusId).select('defaultLanguage defaultTimezone defaultGradeFormat').lean();
  const defaults = campus ? {
    preferredLanguage: campus.defaultLanguage    || 'en',
    timezone:          campus.defaultTimezone    || 'UTC',
    gradeFormat:       campus.defaultGradeFormat || 'FRACTION',
  } : {};
  campusCache.set(key, defaults);
  return defaults;
}

async function migrateModel({ name, file, role, campusField }) {
  const Model = require(file);
  const userModel = MODEL_LABEL[role] || name;
  const docs = await Model.find({}).select(`_id ${campusField || ''}`).lean();

  let created = 0;
  let skipped = 0;

  for (const doc of docs) {
    const campusId = campusField ? doc[campusField] ?? null : null;
    const defaults = await getCampusDefaults(campusId);

    const result = await UserPreferences.findOneAndUpdate(
      { userId: doc._id },
      { $setOnInsert: { userId: doc._id, userModel, campusId, ...defaults } },
      { upsert: true, new: false, setDefaultsOnInsert: true }
    );

    if (result === null) created++;
    else skipped++;
  }

  console.log(`  [${name}] ${docs.length} users — created: ${created}, already existed: ${skipped}`);
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.DB_URI);
  console.log('✅ Connected to MongoDB');
  console.log('🔄 Migrating UserPreferences...\n');

  for (const modelDef of MODELS) {
    await migrateModel(modelDef);
  }

  console.log('\n✅ Migration complete.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
