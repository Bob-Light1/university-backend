/**
 * Response Helpers
 * Standardized response formats for API endpoints
 * Ensures consistency across all controllers
 */

/**
 * Send success response
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Success message
 * @param {Object} data - Response data
 * @param {Object} meta - Additional metadata (pagination, etc.)
 */
const sendSuccess = (res, statusCode = 200, message = 'Success', data = null, meta = null) => {
  const response = {
    success: true,
    message
  };

  if (data !== null) {
    response.data = data;
  }

  if (meta !== null) {
    response.meta = meta;
  }

  return res.status(statusCode).json(response);
};

/**
 * Send error response
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Error message
 * @param {Object} errors - Detailed errors (validation, etc.)
 */
const sendError = (res, statusCode = 500, message = 'Internal server error', errors = null) => {
  const response = {
    success: false,
    message
  };

  if (errors !== null) {
    response.errors = errors;
  }

  // Only include stack trace in development
  if (process.env.NODE_ENV === 'development' && errors?.stack) {
    response.stack = errors.stack;
  }

  return res.status(statusCode).json(response);
};

/**
 * Send paginated response
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Success message
 * @param {Array} data - Array of items
 * @param {Object} pagination - Pagination info
 */
const sendPaginated = (res, statusCode = 200, message = 'Success', data = [], pagination = {}) => {
  const { total = 0, page = 1, limit = 10, ...paginationRest } = pagination;

  const response = {
    success: true,
    message,
    data,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
      hasNext: Number(page) < Math.ceil(total / Number(limit)),
      hasPrev: Number(page) > 1,
      ...paginationRest,
    }
  };

  return res.status(statusCode).json(response);
};

/**
 * Send validation error response
 * @param {Object} res - Express response object
 * @param {Array|Object} errors - Validation errors
 */
const sendValidationError = (res, errors) => {
  // Handle Mongoose validation errors
  if (errors.name === 'ValidationError') {
    const validationErrors = Object.values(errors.errors).map(err => ({
      field: err.path,
      message: err.message
    }));

    return sendError(res, 400, 'Validation failed', validationErrors);
  }

  // Handle custom validation errors
  return sendError(res, 400, 'Validation failed', errors);
};

/**
 * Send not found error
 * @param {Object} res - Express response object
 * @param {String} resource - Resource name
 */
const sendNotFound = (res, resource = 'Resource') => {
  return sendError(res, 404, `${resource} not found`);
};

/**
 * Send unauthorized error
 * @param {Object} res - Express response object
 * @param {String} message - Custom message
 */
const sendUnauthorized = (res, message = 'Authentication required') => {
  return sendError(res, 401, message);
};

/**
 * Send forbidden error
 * @param {Object} res - Express response object
 * @param {String} message - Custom message
 */
const sendForbidden = (res, message = 'You do not have permission to perform this action') => {
  return sendError(res, 403, message);
};

/**
 * Send conflict error (duplicate resources)
 * @param {Object} res - Express response object
 * @param {String} message - Custom message
 */
const sendConflict = (res, message = 'Resource already exists') => {
  return sendError(res, 409, message);
};

/**
 * Handle MongoDB duplicate key errors
 * @param {Object} res - Express response object
 * @param {Object} error - MongoDB error object
 */
const handleDuplicateKeyError = (res, error) => {
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    const value = error.keyValue[field];
    return sendConflict(res, `${field} '${value}' is already in use`);
  }
  return sendError(res, 500, 'Database error');
};

/**
 * Handle async controller errors
 * Wraps async route handlers to catch errors
 * @param {Function} fn - Async controller function
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Format validation errors from express-validator
 * @param {Array} errors - Array of validation errors
 */
const formatValidationErrors = (errors) => {
  return errors.map(err => ({
    field: err.param || err.path,
    message: err.msg,
    value: err.value
  }));
};

/**
 * Send created response (201)
 * @param {Object} res - Express response object
 * @param {String} message - Success message
 * @param {Object} data - Created resource
 */
const sendCreated = (res, message = 'Resource created successfully', data = null) => {
  return sendSuccess(res, 201, message, data);
};

/**
 * Send no content response (204)
 * @param {Object} res - Express response object
 */
const sendNoContent = (res) => {
  return res.status(204).send();
};

/**
 * Send rate limit error
 * @param {Object} res - Express response object
 * @param {String} message - Custom message
 * @param {Number} retryAfter - Seconds until retry allowed
 */
const sendRateLimitError = (res, message = 'Too many requests', retryAfter = 60) => {
  return res.status(429).json({
    success: false,
    message,
    retryAfter
  });
};

module.exports = {
  sendSuccess,
  sendError,
  sendPaginated,
  sendValidationError,
  sendNotFound,
  sendUnauthorized,
  sendForbidden,
  sendConflict,
  sendCreated,
  sendNoContent,
  sendRateLimitError,
  handleDuplicateKeyError,
  asyncHandler,
  formatValidationErrors
};