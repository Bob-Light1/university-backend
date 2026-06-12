// SHIM temporaire (Phase 10 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/document/services/document.qr.service.js
// Consommateurs restants : services/academic-pdf.service.js (domaine academic-print, pas encore migré)
module.exports = require('../../modules/document/services/document.qr.service');
