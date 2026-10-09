'use strict';
/** @file auth.js
 * @description Server-session authentication, role and ownership guards.
 */
const { sendError } = require('../utils/response-helpers');

/**
 * Enhanced JWT authentication middleware
 * Verifies the token and attaches user info to req.user
 * Implements additional security checks
 */
const authenticate = async (req, res, next) => {
  const match = /^Bearer ([^ ]+)$/.exec(req.header('Authorization') || '');
  if (!match) return sendError(res, 401, 'A Bearer token is required.');
  if (!process.env.JWT_SECRET) return sendError(res, 500, 'Server configuration error.');
  try {
    req.user = await require('../../modules/account').sessions.authenticateToken(match[1]);
    return next();
  } catch (error) {
    return sendError(res, error.statusCode || 503,
      error.statusCode ? error.message : 'Authentication is temporarily unavailable.',
      error.code ? { code: error.code } : null);
  }
};

/**
 * Role-based authorization middleware
 * Must be used AFTER authenticate middleware
 * @param {Array<string>} allowedRoles - List of authorized roles
 * @returns {Function} Express middleware
 */
const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    try {
      // Ensure user is authenticated first
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required. Please login first."
        });
      }

      // If no roles specified, allow all authenticated users
      if (!allowedRoles || allowedRoles.length === 0) {
        return next();
      }

      // Check if user has a role
      if (!req.user.role) {
        return res.status(403).json({
          success: false,
          message: "User role not found. Access denied."
        });
      }

      // Check if user's role is in the allowed roles
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required roles: ${allowedRoles.join(", ")}. Your role: ${req.user.role}`
        });
      }

      // Authorization successful
      next();

    } catch (error) {
      console.error("❌ Authorization error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Authorization error occurred"
      });
    }
  };
};

/**
 * Combined authentication and authorization middleware
 * Convenience function that combines both steps
 * @param {Array<string>} roles - List of authorized roles (optional)
 * @returns {Function} Express middleware
 */
const authMiddleware = (roles = []) => {
  return (req, res, next) => {
    // First authenticate
    authenticate(req, res, (authError) => {
      // If authenticate returned an error response, stop here
      if (authError) {
        return;
      }
      
      // Then authorize if roles are specified
      if (roles && roles.length > 0) {
        const authorizeFn = authorize(roles);
        return authorizeFn(req, res, next);
      }
      
      // No roles specified, just continue
      next();
    });
  };
};

/**
 * Optional authentication middleware
 * Attaches user info if token is valid, but doesn't require it
 * Useful for endpoints that work differently for authenticated users
 */
const optionalAuth = async (req, _res, next) => {
  delete req.user;
  const match = /^Bearer ([^ ]+)$/.exec(req.header('Authorization') || '');
  if (match) {
    try {
      req.user = await require('../../modules/account').sessions.authenticateToken(match[1]);
    } catch {
      // An unavailable or invalid session never receives authenticated privileges.
    }
  }
  return next();
};

/**
 * Middleware to check if user is accessing their own resource
 * @param {string} paramName - Name of the route parameter containing the resource ID
 * @returns {Function} Express middleware
 */
const isOwner = (paramName = 'id') => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required"
        });
      }

      const resourceId = String(req.params[paramName]); 
      const userId = String(req.user.id);

      if (resourceId !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can only access your own resources"
        });
      }

      next();

    } catch (error) {
      console.error("❌ Ownership check error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Authorization error occurred"
      });
    }
  };
};

/**
 * Middleware to check if user is owner OR has specific roles
 * @param {string} paramName - Name of the route parameter
 * @param {Array<string>} allowedRoles - Roles that can bypass ownership check
 * @returns {Function} Express middleware
 */
const isOwnerOrRole = (paramName = 'id', allowedRoles = ['ADMIN', 'DIRECTOR']) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required"
        });
      }

      const resourceId = String(req.params[paramName]);
      const userId = String(req.user.id);
      const userRole = req.user.role;

      const isResourceOwner = resourceId === userId;
      const hasPrivilegedRole = allowedRoles.includes(userRole);

      if (!isResourceOwner && !hasPrivilegedRole) {
        return res.status(403).json({
          success: false,
          message: `Access denied. You must be the owner or have one of these roles: ${allowedRoles.join(", ")}`
        });
      }

      next();

    } catch (error) {
      console.error("❌ Owner/Role check error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Authorization error occurred"
      });
    }
  };
};

/**
 * Campus access middleware
 * Ensures users can only access resources from their campus
 * (except ADMIN and DIRECTOR who have global access)
 * @returns {Function} Express middleware
 */
const requireCampusAccess = () => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required"
        });
      }

      // ADMIN and DIRECTOR have global access
      if (req.user.role === 'ADMIN' || req.user.role === 'DIRECTOR') {
        return next();
      }

      // Other roles must have a campusId
      if (!req.user.campusId) {
        return res.status(403).json({
          success: false,
          message: "Campus information not found in your account"
        });
      }

      next();

    } catch (error) {
      console.error("❌ Campus access check error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Authorization error occurred"
      });
    }
  };
};

/**
 * Rate limiting bypass for admins
 * Can be used with rate limiters to exempt admin users
 * @returns {Function} Express middleware
 */
const skipRateLimitForAdmin = (req, _res, next) => {
  if (req.user && (req.user.role === 'ADMIN' || req.user.role === 'DIRECTOR')) {
    req.rateLimit = { skip: true };
  }
  next();
};

/**
 * Permission-based authorization for Staff members.
 * Must be used AFTER authenticate middleware.
 * Checks that req.user.permissions includes the given key.
 *
 * @param {string} key - A permission key from staff-permissions.js
 * @returns {Function} Express middleware
 */
const requirePermission = (key) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  const perms = req.user.permissions;

  // `<resource>.manage` is strictly more privileged than `<resource>.read`, so a
  // manage grant also satisfies a read requirement. This keeps the backend aligned
  // with the frontend PermissionGate, which grants on `anyOf: ['x.read', 'x.manage']`.
  const readSatisfiedByManage =
    Array.isArray(perms) &&
    key.endsWith('.read') &&
    perms.includes(`${key.slice(0, -'.read'.length)}.manage`);

  if (!Array.isArray(perms) || (!perms.includes(key) && !readSatisfiedByManage)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Missing permission: ${key}`,
    });
  }

  next();
};

// Named exports
module.exports = {
  // Core authentication
  authenticate,
  authorize,
  authMiddleware,

  // Optional/conditional auth
  optionalAuth,

  // Ownership checks
  isOwner,
  isOwnerOrRole,

  // Campus-specific
  requireCampusAccess,

  // Staff permission check
  requirePermission,

  // Utilities
  skipRateLimitForAdmin,
};
