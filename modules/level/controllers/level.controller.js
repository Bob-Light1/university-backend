'use strict';

/**
 * @file level.controller.js — HTTP layer for the academic-level domain.
 * @description CRUD + archive/restore for `Level` documents. Levels are a
 * global (non campus-scoped) reference collection shared across all campuses,
 * so no campus filter applies here. Persistence is delegated to the repository;
 * this layer only handles input validation and response shaping.
 */

const levelRepo = require('../level.repository');
const {
  sendSuccess,
  sendCreated,
  sendError,
  sendNotFound,
  sendConflict,
  asyncHandler,
  handleDuplicateKeyError,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');

const LEVEL_TYPES = ['LANGUAGE', 'ACADEMIC', 'PROFESSIONAL'];

/**
 * Parse and validate the `order` field.
 * @returns {{ value: number } | { error: string }}
 */
const parseOrder = (raw) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { error: 'Order must be an integer greater than or equal to 1' };
  }
  return { value };
};

/**
 * Create a new level.
 * @route POST /api/level
 * @access ADMIN / DIRECTOR / CAMPUS_MANAGER
 */
exports.createLevel = asyncHandler(async (req, res) => {
  const { name, code, type, order, description } = req.body;

  // Presence validation (the model enforces enums/required as last line of defense).
  if (!name || !code || order === undefined || order === null || order === '') {
    return sendError(res, 400, 'Name, code and order are required');
  }
  if (type !== undefined && !LEVEL_TYPES.includes(type)) {
    return sendError(res, 400, 'Invalid level type');
  }

  const parsedOrder = parseOrder(order);
  if (parsedOrder.error) return sendError(res, 400, parsedOrder.error);

  const resolvedType = type || 'LANGUAGE';

  // Pre-check uniqueness (code, type) for a clean 409 before hitting the index.
  const exists = await levelRepo.findByCodeAndType(code, resolvedType);
  if (exists) {
    return sendConflict(res, 'A level with this code already exists for this type');
  }

  try {
    const level = await levelRepo.create({
      name,
      code,
      type: resolvedType,
      order: parsedOrder.value,
      description,
    });
    return sendCreated(res, 'Level created successfully', level);
  } catch (error) {
    // Race condition or a stricter pre-existing index: surface as a 409.
    if (error.code === 11000) return handleDuplicateKeyError(res, error);
    throw error;
  }
});

/**
 * Get all levels, sorted by ascending order.
 * Supports filtering by `type` and including archived levels.
 * @route GET /api/level
 * @access AUTHENTICATED
 */
exports.getLevels = asyncHandler(async (req, res) => {
  const { type, includeArchived } = req.query;

  if (type !== undefined && !LEVEL_TYPES.includes(type)) {
    return sendError(res, 400, 'Invalid level type');
  }

  const levels = await levelRepo.list({
    type,
    includeArchived: includeArchived === 'true' || includeArchived === true,
  });

  return sendSuccess(res, 200, 'Levels retrieved successfully', levels, {
    count: levels.length,
  });
});

/**
 * Get a single level by ID.
 * @route GET /api/level/:id
 * @access AUTHENTICATED
 */
exports.getLevelById = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return sendError(res, 400, 'Invalid level ID');
  }

  const level = await levelRepo.findById(req.params.id);
  if (!level) return sendNotFound(res, 'Level');

  return sendSuccess(res, 200, 'Level retrieved successfully', level);
});

/**
 * Update level information (partial update).
 * @route PUT /api/level/update/:id
 * @access ADMIN / DIRECTOR / CAMPUS_MANAGER
 */
exports.updateLevel = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return sendError(res, 400, 'Invalid level ID');
  }

  const { name, code, type, order, description, status } = req.body;

  // Build the set of fields actually provided (partial update semantics).
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (code !== undefined) fields.code = code;
  if (type !== undefined) {
    if (!LEVEL_TYPES.includes(type)) return sendError(res, 400, 'Invalid level type');
    fields.type = type;
  }
  if (order !== undefined) {
    const parsedOrder = parseOrder(order);
    if (parsedOrder.error) return sendError(res, 400, parsedOrder.error);
    fields.order = parsedOrder.value;
  }
  if (description !== undefined) fields.description = description;
  if (status !== undefined) {
    if (!['active', 'archived'].includes(status)) {
      return sendError(res, 400, 'Invalid status');
    }
    fields.status = status;
  }

  if (Object.keys(fields).length === 0) {
    return sendError(res, 400, 'No valid fields provided for update');
  }

  try {
    const level = await levelRepo.updateById(req.params.id, fields);
    if (!level) return sendNotFound(res, 'Level');
    return sendSuccess(res, 200, 'Level updated successfully', level);
  } catch (error) {
    if (error.code === 11000) return handleDuplicateKeyError(res, error);
    throw error;
  }
});

/**
 * Soft delete a level (archive).
 * @route DELETE /api/level/delete/:id
 * @access ADMIN / DIRECTOR / CAMPUS_MANAGER
 */
exports.deleteLevel = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return sendError(res, 400, 'Invalid level ID');
  }

  const level = await levelRepo.setStatus(req.params.id, 'archived');
  if (!level) return sendNotFound(res, 'Level');

  return sendSuccess(res, 200, 'Level archived successfully');
});

/**
 * Restore an archived level.
 * @route PATCH /api/level/:id/restore
 * @access ADMIN / DIRECTOR / CAMPUS_MANAGER
 */
exports.restoreLevel = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return sendError(res, 400, 'Invalid level ID');
  }

  const level = await levelRepo.findById(req.params.id);
  if (!level) return sendNotFound(res, 'Level');

  if (level.status !== 'archived') {
    return sendError(res, 400, 'Level is not archived');
  }

  await levelRepo.setStatus(req.params.id, 'active');
  return sendSuccess(res, 200, 'Level restored successfully');
});
