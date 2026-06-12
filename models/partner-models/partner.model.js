// SHIM temporaire (Phase 9 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/partner/models/partner.model.js
// Consommateurs restants : modules/public-portal (public.register, public.campus)
module.exports = require('../../modules/partner/models/partner.model');
