'use strict';

/**
 * @file parentChildrenSchema.js
 * @description Validation middleware for linking/unlinking students to a parent.
 *
 *  The children[] field is a replacement array — it replaces the entire
 *  children list on every PATCH call. Each studentId is validated for:
 *    1. Valid ObjectId format
 *    2. Belongs to the parent's schoolCampus (validated in the controller)
 *    3. Array size ≤ 10
 *
 * @route PATCH /api/parents/:id/children
 */

const mongoose = require('mongoose');

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/**
 * Validates the children replacement payload.
 * Body: { children: [ObjectId, ...] }
 */
const validateParentChildren = (req, res, next) => {
  const errors = [];
  const { children } = req.body;

  if (children === undefined || children === null) {
    return res.status(400).json({
      success: false,
      message:  'Validation failed.',
      errors:   [{ field: 'children', message: 'children array is required.' }],
    });
  }

  if (!Array.isArray(children)) {
    return res.status(400).json({
      success: false,
      message:  'Validation failed.',
      errors:   [{ field: 'children', message: 'children must be an array of student ObjectIds.' }],
    });
  }

  if (children.length > 10) {
    errors.push({ field: 'children', message: 'A parent cannot have more than 10 children linked.' });
  }

  children.forEach((id, i) => {
    if (!isObjectId(id)) {
      errors.push({ field: `children[${i}]`, message: `children[${i}] ("${id}") is not a valid ObjectId.` });
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }

  next();
};

module.exports = { validateParentChildren };
