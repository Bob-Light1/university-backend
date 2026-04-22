/**
 * Validation Helpers
 * Cross-campus security validation and data integrity checks
 * Essential for multi-tenant architecture
 */

const mongoose = require('mongoose');
const Campus = require('../models/campus.model');
const Class = require('../models/class.model');
const Teacher = require('../models/teacher-models/teacher.model');
const Student = require('../models/student-models/student.model');

/**
 * Validate MongoDB ObjectId format
 * @param {String} id - ID to validate
 * @returns {Boolean}
 */
const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

/**
 * Validate multiple ObjectIds
 * @param {Array} ids - Array of IDs to validate
 * @returns {Boolean}
 */
const areValidObjectIds = (ids) => {
  if (!Array.isArray(ids)) return false;
  return ids.every(id => isValidObjectId(id));
};

/**
 * Check if a class belongs to a specific campus
 * @param {String} classId - Class ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateClassBelongsToCampus = async (classId, campusId) => {
  try {
    if (!isValidObjectId(classId) || !isValidObjectId(campusId)) {
      return false;
    }

    const classDoc = await Class.findById(classId);
    
    if (!classDoc) {
      return false;
    }

    return classDoc.campus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating class campus:', error);
    return false;
  }
};

/**
 * Check if a teacher belongs to a specific campus
 * @param {String} teacherId - Teacher ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateTeacherBelongsToCampus = async (teacherId, campusId) => {
  try {
    if (!isValidObjectId(teacherId) || !isValidObjectId(campusId)) {
      return false;
    }

    const teacher = await Teacher.findById(teacherId);
    
    if (!teacher) {
      return false;
    }

    return teacher.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating teacher campus:', error);
    return false;
  }
};

/**
 * Check if a student belongs to a specific campus
 * @param {String} studentId - Student ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateStudentBelongsToCampus = async (studentId, campusId) => {
  try {
    if (!isValidObjectId(studentId) || !isValidObjectId(campusId)) {
      return false;
    }

    const student = await Student.findById(studentId);
    
    if (!student) {
      return false;
    }

    return student.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating student campus:', error);
    return false;
  }
};

/**
 * Validate that multiple classes belong to the same campus
 * @param {Array} classIds - Array of class IDs
 * @param {String} campusId - Campus ID
 * @returns {Promise<Object>} { valid: Boolean, invalidClasses: Array }
 */
const validateMultipleClassesBelongToCampus = async (classIds, campusId) => {
  try {
    if (!areValidObjectIds(classIds) || !isValidObjectId(campusId)) {
      return { valid: false, invalidClasses: classIds };
    }

    const classes = await Class.find({ _id: { $in: classIds } });

    const invalidClasses = classes
      .filter(cls => cls.campus.toString() !== campusId.toString())
      .map(cls => cls._id.toString());

    return {
      valid: invalidClasses.length === 0,
      invalidClasses
    };
  } catch (error) {
    console.error('Error validating multiple classes:', error);
    return { valid: false, invalidClasses: classIds };
  }
};

/**
 * Check if campus has reached capacity limit
 * @param {String} campusId - Campus ID
 * @param {String} resourceType - 'students', 'teachers', or 'classes'
 * @returns {Promise<Object>} { canAdd: Boolean, current: Number, max: Number }
 */
const checkCampusCapacity = async (campusId, resourceType = 'students') => {
  try {
    if (!isValidObjectId(campusId)) {
      throw new Error('Invalid campus ID');
    }

    const campus = await Campus.findById(campusId);
    
    if (!campus) {
      throw new Error('Campus not found');
    }

    let current = 0;
    let max = 0;

    switch (resourceType) {
      case 'students':
        current = await Student.countDocuments({ 
          schoolCampus: campusId, 
          status: { $ne: 'archived' } 
        });
        max = campus.features?.maxStudents || 1000;
        break;

      case 'teachers':
        current = await Teacher.countDocuments({ 
          schoolCampus: campusId, 
          status: { $ne: 'archived' } 
        });
        max = campus.features?.maxTeachers || 100;
        break;

      case 'classes':
        current = await Class.countDocuments({ 
          campus: campusId, 
          status: { $ne: 'archived' } 
        });
        max = campus.features?.maxClasses || 50;
        break;

      default:
        throw new Error('Invalid resource type');
    }

    return {
      canAdd: current < max,
      current,
      max,
      remaining: max - current
    };
  } catch (error) {
    console.error('Error checking campus capacity:', error);
    throw error;
  }
};

/**
 * Validate email format
 * @param {String} email - Email to validate
 * @returns {Boolean}
 */
const isValidEmail = (email) => {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
};

/**
 * Validate phone number format
 * @param {String} phone - Phone to validate
 * @returns {Boolean}
 */
const isValidPhone = (phone) => {
  const phoneRegex = /^\+?[0-9\s()-]{6,20}$/;
  return phoneRegex.test(phone);
};

/**
 * Validate password strength
 * @param {String} password - Password to validate
 * @returns {Object} { valid: Boolean, errors: Array }
 */
const validatePasswordStrength = (password) => {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

/**
 * Validate user has permission to access campus resources
 * @param {Object} user - User from JWT (req.user)
 * @param {String} campusId - Campus ID to access
 * @returns {Boolean}
 */
const canAccessCampus = (user, campusId) => {
  // ADMIN and DIRECTOR can access all campuses
  if (user.role === 'ADMIN' || user.role === 'DIRECTOR') {
    return true;
  }

  // CAMPUS_MANAGER can only access their own campus
  if (user.role === 'CAMPUS_MANAGER') {
    return user.campusId && user.campusId.toString() === campusId.toString();
  }

  // Other roles (TEACHER, STUDENT) can only access their campus
  return user.campusId && user.campusId.toString() === campusId.toString();
};

/**
 * Build a MongoDB campus isolation filter based on the authenticated user's role.
 *
 * CRITICAL — multi-tenant security boundary.
 *
 * Rules:
 *  - ADMIN / DIRECTOR : cross-campus access. An optional `requestedCampusId`
 *    narrows the query; without it, no campus filter is applied (full access).
 *  - All other roles  : MUST have a valid campusId in their JWT payload.
 *    If campusId is missing or invalid an Error is thrown so that the caller
 *    can return a 403/500 instead of silently leaking data from every campus
 *    (Mongoose ignores { schoolCampus: undefined } → full collection scan).
 *
 * @param {Object}  user               - req.user (decoded JWT payload)
 * @param {string|null} requestedCampusId - Optional campus override (ADMIN/DIRECTOR only)
 * @returns {Object} MongoDB filter  e.g. { schoolCampus: ObjectId }
 * @throws  {Error}  When a non-global role has no valid campusId
 */
const buildCampusFilter = (user, requestedCampusId = null) => {
  const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

  if (GLOBAL_ROLES.includes(user.role)) {
    // Global roles: optionally scope to a specific campus
    return requestedCampusId && isValidObjectId(requestedCampusId)
      ? { schoolCampus: requestedCampusId }
      : {};
  }

  // All non-global roles MUST have a campus bound in their JWT.
  // Throw synchronously so callers can catch and return 403.
  if (!user.campusId || !isValidObjectId(String(user.campusId))) {
    throw new Error(
      `Campus isolation breach prevented: role '${user.role}' has no valid campusId in JWT.`
    );
  }

  return { schoolCampus: user.campusId };
};

/**
 * Sanitize user input to prevent injection attacks
 * @param {String} input - User input
 * @returns {String} Sanitized input
 */
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  
  // Remove potentially dangerous characters
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
};

/**
 * Validate date is not in the future
 * @param {Date} date - Date to validate
 * @returns {Boolean}
 */
const isDateNotFuture = (date) => {
  if (!date) return true;
  return new Date(date) < new Date();
};

/**
 * Check if user owns a resource
 * @param {Object} user - User from JWT
 * @param {String} resourceOwnerId - ID of resource owner
 * @returns {Boolean}
 */
const isResourceOwner = (user, resourceOwnerId) => {
  if (!user || !user.id || !resourceOwnerId) {
    return false;
  }
  return user.id.toString() === resourceOwnerId.toString();
};

module.exports = {
  // ObjectId validation
  isValidObjectId,
  areValidObjectIds,

  // Campus validation (CRITICAL for security)
  validateClassBelongsToCampus,
  validateTeacherBelongsToCampus,
  validateStudentBelongsToCampus,
  validateMultipleClassesBelongToCampus,
  checkCampusCapacity,

  // Permission validation
  canAccessCampus,
  buildCampusFilter,
  isResourceOwner,

  // Input validation
  isValidEmail,
  isValidPhone,
  validatePasswordStrength,
  sanitizeInput,
  isDateNotFuture
};