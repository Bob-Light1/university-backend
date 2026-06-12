'use strict';

/**
 * @file counter.model.js
 * @description Compteur atomique MongoDB pour la génération de références uniques.
 *
 *  Utilisation :
 *  ─────────────────────────
 *  const { nextSequence } = require('./counter.model');
 *  const seq = await nextSequence('result_2025'); // → 1, 2, 3…
 *  const ref = `RES-2025-${String(seq).padStart(5, '0')}`; // → "RES-2025-00001"
 */

const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema(
  {
    /** Identifiant du compteur (ex. "result_2025", "grading_scale_2025") */
    _id: { type: String, required: true },

    /** Valeur courante du compteur — incrémentée atomiquement */
    seq: { type: Number, default: 0 },
  },
  {
    // Pas de timestamps ici — le compteur est purement technique
    collection: 'counters',
    versionKey:  false,
  }
);

const Counter = mongoose.model('Counter', CounterSchema);

/**
 * Incrémente atomiquement le compteur `name` et retourne la nouvelle valeur.
 * Crée le document compteur s'il n'existe pas (upsert: true).
 *
 * @param  {string} name  - Identifiant du compteur (ex. "result_2025")
 * @returns {Promise<number>}  Séquence suivante (commence à 1)
 */
const nextSequence = async (name) => {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

/**
 * Génère une référence lisible unique pour un résultat.
 * Format : "RES-YYYY-NNNNN" (ex. "RES-2025-00042")
 *
 * @param  {number} [year]  - Année (défaut : année courante)
 * @returns {Promise<string>}
 */
const nextResultRef = async (year = new Date().getFullYear()) => {
  const seq = await nextSequence(`result_${year}`);
  return `RES-${year}-${String(seq).padStart(5, '0')}`;
};

module.exports = { Counter, nextSequence, nextResultRef };