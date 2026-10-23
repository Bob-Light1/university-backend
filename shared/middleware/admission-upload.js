'use strict';

/** @file admission-upload.js @description Bounded in-memory file parsing, always mounted after dossier authorization. */
const multer = require('multer');
const { DOSSIER_LIMITS, ADMISSION_ERRORS } = require('../constants/admission.constants');
const { sendError } = require('../utils/response-helpers');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOSSIER_LIMITS.maxFileBytes, files: 1, fields: 4, fieldSize: 1024 },
}).single('file');

/** Return bounded validation failures using the normal API error envelope. */
module.exports = (req, res, next) => upload(req, res, (error) => error
  ? sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'Invalid dossier upload', { code: ADMISSION_ERRORS.FILE })
  : next());
