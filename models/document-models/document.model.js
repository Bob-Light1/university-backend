// SHIM temporaire (Phase 10 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/document/models/document.model.js
// Consommateurs restants : modules/staff/controllers/staff.readonly.controller.js
module.exports = require('../../modules/document/models/document.model');
