'use strict';

/**
 * @file level.repository.js — couche de persistance du domaine level.
 *
 * Only file in the module allowed to touch the Mongoose `Level` model.
 * Controllers and service call this repository (never the model directly).
 * Goal (step 0 of the Postgres migration preparation — see POSTGRES_MIGRATION_ASSESSMENT.md):
 * isolate persistence so the internals can later be rewritten (Postgres)
 * without touching the HTTP layer or the inter-module API.
 *
 * Convention: READ methods return plain objects (.lean());
 * WRITE methods do load→mutate→save to preserve the schema's setters/validations
 * (e.g. `uppercase: true` on name/code).
 */

const Level = require('./level.model');

/**
 * Looks up a level by (code, type) — used for the uniqueness check.
 * @returns {Promise<Object|null>} plain object or null
 */
const findByCodeAndType = (code, type) =>
  Level.findOne({ code, type }).lean();

/**
 * Creates a level.
 * @param {Object} data - { name, code, type, order, description }
 * @returns {Promise<Object>} the created document
 */
const create = (data) => Level.create(data);

/**
 * Lists active levels, sorted by ascending `order`, optionally filtered
 * by type.
 * @param {{ type?: string }} [opts]
 * @returns {Promise<Object[]>}
 */
const listActive = ({ type } = {}) => {
  const filter = { status: 'active' };
  if (type) filter.type = type;
  return Level.find(filter).sort({ order: 1 }).lean();
};

/**
 * Retrieves a level by id (read).
 * @returns {Promise<Object|null>}
 */
const findById = (id) => Level.findById(id).lean();

/**
 * Updates the provided fields of a level (load→assign→save: preserves setters
 * and validations, and propagates the E11000 duplicate error to the caller).
 * @param {string} id
 * @param {Object} fields - only the fields to modify
 * @returns {Promise<Object|null>} the updated document, or null if not found
 */
const updateById = async (id, fields) => {
  const level = await Level.findById(id);
  if (!level) return null;
  Object.assign(level, fields);
  await level.save();
  return level;
};

/**
 * Changes the status of a level (active/archived) — archiving & restoration.
 * @returns {Promise<Object|null>} the updated document, or null if not found
 */
const setStatus = async (id, status) => {
  const level = await Level.findById(id);
  if (!level) return null;
  level.status = status;
  await level.save();
  return level;
};

module.exports = {
  findByCodeAndType,
  create,
  listActive,
  findById,
  updateById,
  setStatus,
};
