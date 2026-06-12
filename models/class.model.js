// SHIM temporaire (Phase 16 monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Nouveau chemin : modules/class/class.model.js
// Consommateurs restants : modules/{gaet,course,document,result,exam} + campus.controller,
// academic-print, student.controller, utils/{schedule-helpers,validation-helpers}
module.exports = require('../modules/class/class.model');
