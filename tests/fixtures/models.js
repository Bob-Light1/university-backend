'use strict';

/**
 * @file models.js
 * @description Loads every Mongoose model of the platform and exposes them by name.
 *
 * Model files are discovered on disk rather than listed here, and rather than
 * trusting `mongoose.modelNames()`: a model nobody imported would otherwise be
 * invisible to the seed, and its collection would survive the purge — the exact
 * failure `tests/unit/hard-delete.test.js` guards against for the registry.
 *
 * The fixture deliberately does NOT reach into `shared/lib/hard-delete`'s internal
 * model map: that registry is internal to the danger zone (CLAUDE.md §5.2).
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SEARCH_ROOTS = ['modules', 'shared'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'docs', '.git', 'uploads', 'tests']);

/**
 * @param {string} dir
 * @param {string[]} [found]
 * @returns {string[]} Absolute paths of every `*.model.js` under `dir`.
 */
const collectModelFiles = (dir, found = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) collectModelFiles(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith('.model.js')) {
      found.push(path.join(dir, entry.name));
    }
  }

  return found;
};

let loaded = false;

/**
 * Requires every model file once, registering the schemas on the shared
 * Mongoose connection.
 *
 * @returns {string[]} Registered model names, sorted.
 */
const loadAllModels = () => {
  if (!loaded) {
    SEARCH_ROOTS.forEach((root) => {
      collectModelFiles(path.join(REPO_ROOT, root)).forEach((file) => require(file));
    });
    loaded = true;
  }

  return mongoose.modelNames().sort();
};

/**
 * @param {string} name
 * @returns {import('mongoose').Model} The registered model.
 * @throws {Error} When no model of that name exists — a typo in a builder must
 *                 stop the seed, never seed an empty collection silently.
 */
const model = (name) => {
  loadAllModels();

  if (!mongoose.modelNames().includes(name)) {
    throw new Error(`Fixture references unknown model '${name}'. Registered: ${mongoose.modelNames().sort().join(', ')}`);
  }

  return mongoose.model(name);
};

module.exports = { loadAllModels, model, collectModelFiles, REPO_ROOT };
