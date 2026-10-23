'use strict';

/** @file admission-response.js @description Consistent admission errors across management and private portal routes. */
const { asyncHandler, sendError } = require('./response-helpers');
const { ADMISSION_ERRORS: E } = require('../constants/admission.constants');

/** Preserve typed business failures while hiding internal storage/database errors. */
const admissionHandler = (work) => asyncHandler(async (req, res, next) => {
  try {
    return await work(req, res, next);
  } catch (error) {
    if (Object.values(E).includes(error.code)) return sendError(res, error.statusCode || 400, error.message, { code: error.code });
    if (error.code === 11000) return sendError(res, 409, 'The student identity is already registered', { code: E.DUPLICATE });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return sendError(res, 400, 'The supplied admission data is invalid', { code: E.INVALID });
    }
    if (error.code === 'LIMIT_FILE_SIZE') return sendError(res, 413, 'The file exceeds the upload limit', { code: E.FILE });
    throw error;
  }
});

module.exports = { admissionHandler };
