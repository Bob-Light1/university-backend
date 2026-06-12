// SHIM temporaire (Phase 17 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/teacher/models/teacher.schedule.model.js
// Consommateurs restants : modules/{gaet,exam} + student.schedule.controller + utils/schedule-helpers
module.exports = require('../../modules/teacher/models/teacher.schedule.model');
