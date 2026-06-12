// SHIM temporaire (Phase 11 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/result/models/result.model.js
// Consommateurs restants : modules/{parent,staff,mentor} (readonly/portal) + controllers/student-controllers/student.dashboard.controller.js
module.exports = require('../modules/result/models/result.model');
