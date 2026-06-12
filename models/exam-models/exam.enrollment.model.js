// SHIM temporaire (Phase 12 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/exam/models/exam.enrollment.model.js
// Consommateurs restants : controllers/student-controllers/student.dashboard.controller.js
module.exports = require('../../modules/exam/models/exam.enrollment.model');
