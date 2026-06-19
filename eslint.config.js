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
const path    = require('node:path');

/**
 * Plugin local — cloisonnement des modules (cf. revue d'archi, point 1).
 *
 * Règle `no-cross-module-internals` : à l'intérieur de `modules/<A>/`, un
 * `require()` qui pointe vers un AUTRE module `modules/<B>/` ne peut viser que
 * sa FAÇADE (`../B`, `../B/index`). Tout require d'un fichier interne d'un
 * autre module (`../B/b.service`, `../B/models/...`, …) est interdit.
 *
 * Rend MÉCANIQUE la frontière jusqu'ici disciplinaire : les imports de même
 * module (`../services/...`, `../models/...`) restent libres ; seul le
 * franchissement de frontière hors façade est bloqué.
 */
const MODULE_RE = /\/modules\/([^/]+)(\/.*)?$/;

const moduleBoundaryPlugin = {
  rules: {
    'no-cross-module-internals': {
      meta: {
        type: 'problem',
        docs: { description: 'Interdit le require d’un interne d’un autre module — passer par sa façade index.js.' },
        schema: [],
        messages: {
          crossInternal:
            'Import cross-module interdit : « {{request}} » vise un interne du module « {{target}} ». ' +
            'Passe par sa façade : require(\'../{{target}}\').service (cf. revue d’archi §1).',
        },
      },
      create(context) {
        const filename = context.filename || context.getFilename();
        const here = filename.replace(/\\/g, '/').match(/\/modules\/([^/]+)\//);
        if (!here) return {}; // fichier hors d'un module → non concerné
        const currentModule = here[1];

        return {
          CallExpression(node) {
            if (
              node.callee.type !== 'Identifier' ||
              node.callee.name !== 'require' ||
              node.arguments.length !== 1 ||
              node.arguments[0].type !== 'Literal' ||
              typeof node.arguments[0].value !== 'string'
            ) return;

            const request = node.arguments[0].value;
            if (!request.startsWith('.')) return; // paquet npm ou alias → ignoré

            const resolved = path
              .resolve(path.dirname(filename), request)
              .replace(/\\/g, '/');
            const m = resolved.match(MODULE_RE);
            if (!m) return; // la cible n'est pas dans modules/

            const targetModule = m[1];
            if (targetModule === currentModule) return; // intra-module → autorisé

            const remainder = (m[2] || '').replace(/^\//, '');
            const isFacade = remainder === '' || remainder === 'index' || remainder === 'index.js';
            if (isFacade) return; // façade → autorisé

            context.report({
              node: node.arguments[0],
              messageId: 'crossInternal',
              data: { request, target: targetModule },
            });
          },
        };
      },
    },
  },
};

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

  // Cloisonnement des modules — frontière mécanique (revue d'archi §1).
  // Périmètre : code applicatif des modules uniquement. `tests/` (tests
  // unitaires de repository/model) et `scripts/` (seeds/migrations one-off)
  // accèdent légitimement aux internes → hors périmètre.
  {
    files: ['modules/**/*.js'],
    plugins: { boundaries: moduleBoundaryPlugin },
    rules: {
      'boundaries/no-cross-module-internals': 'error',
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
