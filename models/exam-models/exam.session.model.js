// SHIM temporaire (Phase 12 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/exam/models/exam.session.model.js
// Consommateurs restants : modules/staff/controllers/staff.readonly.controller.js
module.exports = require('../../modules/exam/models/exam.session.model');
