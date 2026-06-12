// SHIM temporaire (Phase 13 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/course/course.model.js
// Consommateurs restants : modules/{staff,mentor} (readonly) + modules/document (document.access.middleware)
module.exports = require('../modules/course/course.model');
