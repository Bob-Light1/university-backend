// SHIM temporaire (Phase 13 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/course/controllers/course.resources.controller.js
// Consommateurs restants : routers/subject.router.js (couplage router↔controller
// cross-domaine préexistant — à résorber à la migration de subject, phase 15)
module.exports = require('../../modules/course/controllers/course.resources.controller');
