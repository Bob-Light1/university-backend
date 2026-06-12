// SHIM temporaire (Phase 15 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/subject/subject.model.js
// Consommateurs restants : modules/{gaet,exam,course} + controllers/campus.controller.js + utils/schedule-helpers.js
module.exports = require('../modules/subject/subject.model');
