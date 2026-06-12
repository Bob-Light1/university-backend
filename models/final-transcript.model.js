// SHIM temporaire (Phase 11 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/result/models/final-transcript.model.js
// Consommateurs restants : controllers/academic-print.controller.js + modules/parent (portal)
module.exports = require('../modules/result/models/final-transcript.model');
