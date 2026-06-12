// SHIM temporaire (Phase 9 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/partner/models/partner.application.model.js
// Consommateurs restants : modules/public-portal (public.partner.application, partner.application.admin)
module.exports = require('../../modules/partner/models/partner.application.model');
