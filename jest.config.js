/**
 * Configuration Jest — harnais de test du backend.
 * Les tests n'ouvrent AUCUNE connexion MongoDB : `app.js` n'a pas d'effet de
 * bord (la connexion vit dans server.js). Les suites couvrent :
 *   - tests/unit/        : fonctions pures de shared/ (aucune dépendance).
 *   - tests/contracts/   : surface des façades de modules ({ routes, service }).
 *   - tests/integration/ : smokes Supertest (routing + auth) sans base de données.
 */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // nanoid v5 est ESM pur → on le remplace par un stub CJS dans les tests.
  moduleNameMapper: {
    '^nanoid$': '<rootDir>/tests/__mocks__/nanoid.js',
  },
  forceExit: true,      // certains modules posent des timers (unref) — on coupe net
  testTimeout: 20000,
};
