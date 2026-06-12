// SHIM temporaire (migration monolithe modulaire) — voir docs/architecture/MODULAR_MONOLITH_MIGRATION.md §8
// Importé par models/student-models/student.model.js (hook post-delete). À supprimer quand student sera migré.
module.exports = require('../modules/parent/parent.model');
