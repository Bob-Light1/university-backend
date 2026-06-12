// SHIM temporaire (migration monolithe modulaire) — voir MODULAR_MONOLITH_MIGRATION.md §8
// Consommateurs restants : utils/login-prefs.util.js (→ module settings, étape C0 du chantier 20b)
module.exports = require('../modules/settings/models/userPreferences.model');
