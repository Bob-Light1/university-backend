/**
 * CommonJS stub for nanoid (v5 = pure ESM, incompatible with Jest's require).
 * Sufficient for the harness: no suite exercises real ID generation.
 * If a test ever needs to validate a reference format, replace it with a
 * real generator or switch to a babel transform.
 */
const nanoid = (size = 21) => 'a'.repeat(size);
const customAlphabet = (_alphabet, size = 21) => () => 'a'.repeat(size);
module.exports = { nanoid, customAlphabet };
