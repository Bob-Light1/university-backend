'use strict';

/**
 * @file eslint.config.js — configuration ESLint « flat » (ESLint 9+).
 *
 * Objectif : filet anti-bug, pas police du style. Le code est déjà homogène par
 * convention (cf. migration modulaire + couche repository). On part des règles
 * recommandées et on désamorce celles qui sont bruyantes mais légitimes ici :
 *   - `catch {}` volontaires (require paresseux, fire-and-forget) → allowEmptyCatch
 *   - `console.*` intentionnel (logs serveur / crons) → autorisé
 *   - variables/args préfixés `_` ignorés (placeholders explicites)
 *
 * Périmètre : backend CommonJS (Node 20). Globals Jest ajoutés sous `tests/`.
 */

const js      = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Fichiers/dossiers exclus du lint.
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'uploads/**',
      'logs/**',
    ],
  },

  // Base : règles recommandées d'ESLint.
  js.configs.recommended,

  // Code applicatif — CommonJS, Node 20.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType:  'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Bugs réels — on garde en erreur.
      'no-unused-vars': ['warn', {
        argsIgnorePattern:   '^_',
        varsIgnorePattern:   '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings:  true,
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Hooks Mongoose enveloppant leur corps dans try/catch→throw : hygiène, pas bug.
      'no-useless-catch': 'warn',

      // Backend : logs serveur intentionnels.
      'no-console': 'off',
    },
  },

  // Tests Jest — ajoute les globals describe/test/expect/jest/beforeEach…
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];
