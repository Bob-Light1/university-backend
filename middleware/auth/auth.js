const jwt = require("jsonwebtoken");

/**
 * Enhanced JWT authentication middleware
 * Verifies the token and attaches user info to req.user
 * Implements additional security checks
 */
const authenticate = (req, res, next) => {
  try {
    // Extract the Authorization header
    const authHeader = req.header("Authorization");
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "No token provided. Authorization denied."
      });
    }

    // Parse Bearer token format
    const parts = authHeader.split(' ');
    
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ 
        success: false,
        message: "Invalid token format. Use: Bearer <token>" 
      });
    }

    const token = parts[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid token format. Authorization denied."
      });
    }

    // Verify JWT_SECRET exists
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("❌ JWT_SECRET is not defined in environment variables");
      return res.status(500).json({
        success: false,
        message: "Server configuration error"
      });
    }

    // Verify and decode the token
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'], // Specify allowed algorithms for security
      issuer: 'school-management-app' // Verify issuer if set during signing
    });
    
    // Attach user information to the request
    req.user = decoded;

    // Additional security: Check if user has required fields
    if (!decoded.id || !decoded.role) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload. Please login again."
      });
    }

    // Proceed to the next middleware
    next();

  } catch (error) {
    console.error("❌ Auth middleware error:", error.message);

    // Handle specific JWT errors
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token. Authorization denied."
      });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please login again."
      });
    }

    if (error.name === "NotBeforeError") {
      return res.status(401).json({
        success: false,
        message: "Token not active yet"
      });
    }

    // Generic error
    return res.status(500).json({
      success: false,
      message: "Authentication error occurred"
    });
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
const optionalAuth = (req, _res, next) => {
  try {
    const authHeader = req.header("Authorization");
    
    if (!authHeader) {
      return next(); // No token, continue without user
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return next(); // Invalid format, continue without user
    }

    const token = parts[1];
    
    if (!token) {
      return next(); // No token, continue without user
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("❌ JWT_SECRET is not defined");
      return next(); // Config error, continue without user
    }

    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    
    next();

  } catch (error) {
    console.log("ℹ️ Optional auth failed (continuing anyway):", error.message);
    next(); // Continue without user on any error
  }
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
  if (!Array.isArray(perms) || !perms.includes(key)) {
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