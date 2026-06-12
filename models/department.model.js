// SHIM temporaire (Phase 14 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/department/department.model.js
// Consommateurs restants : controllers/campus.controller.js + controllers/teacher-controllers/teacher.controller.js
module.exports = require('../modules/department/department.model');
