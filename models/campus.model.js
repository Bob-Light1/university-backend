// SHIM temporaire (Phase 19 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/campus/campus.model.js
// Consommateurs restants : ~32 fichiers (modules + utils + scripts) — résorption
// progressive en phase nettoyage via campus.service.
module.exports = require('../modules/campus/campus.model');
