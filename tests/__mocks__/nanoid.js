/**
 * Stub CommonJS de nanoid (v5 = ESM pur, incompatible avec le require de Jest).
 * Suffisant pour le harnais : aucune suite n'exerce la génération d'ID réelle.
 * Si un test doit un jour valider un format de référence, le remplacer par un
 * vrai générateur ou passer à un transform babel.
 */
const nanoid = (size = 21) => 'a'.repeat(size);
const customAlphabet = (_alphabet, size = 21) => () => 'a'.repeat(size);
module.exports = { nanoid, customAlphabet };
