// SHIM temporaire (Phase 17 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/teacher/models/teacher.model.js
// Consommateurs restants : modules/{gaet,exam,staff,document,class} + campus.controller,
// utils/{schedule-helpers,validation-helpers}, scripts/migrate_user_preferences
module.exports = require('../../modules/teacher/models/teacher.model');
