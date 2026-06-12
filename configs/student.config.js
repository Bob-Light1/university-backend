// SHIM temporaire (Phase 18 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/student/student.config.js
// Consommateurs restants : controllers/campus.controller.js (migre phase 19)
module.exports = require('../modules/student/student.config');
