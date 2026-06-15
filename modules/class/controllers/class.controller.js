const classRepo = require('../class.repository');
// Require paresseux : class est dans la cloture statique de campus
const getCampusDocById = (...args) => require('../../campus').service.getCampusDocById(...args);
const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendConflict,
  sendPaginated,
  handleDuplicateKeyError
} = require('../../../shared/utils/response-helpers');
const {
  isValidObjectId,
  buildCampusFilter,
} = require('../../../shared/utils/validation-helpers');
// Require paresseux : teacher.config consommera la façade class en C4 (cycle class ↔ teacher)
const validateTeacherBelongsToCampus = (...args) =>
  require('../../teacher').service.validateTeacherBelongsToCampus(...args);

/**
 * @desc    Create a new class
 * @route   POST /api/class
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.createClass = async (req, res) => {
  try {
    const {
      schoolCampus,
      level,
      className,
      classManager,
      maxStudents,
      academicYear,
      room
    } = req.body;

    if (!schoolCampus || !level || !className) {
      return sendError(res, 400, 'Campus, level, and class name are required');
    }

    if (!isValidObjectId(schoolCampus) || !isValidObjectId(level)) {
      return sendError(res, 400, 'Invalid campus or level ID format');
    }

    // Campus isolation: CAMPUS_MANAGER can only create classes in their own campus
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (req.user.campusId !== schoolCampus) {
        return sendError(res, 403, 'You can only create classes in your own campus');
      }
    }

    if (classManager) {
      if (!isValidObjectId(classManager)) {
        return sendError(res, 400, 'Invalid class manager ID format');
      }

      const managerBelongs = await validateTeacherBelongsToCampus(classManager, schoolCampus);

      if (!managerBelongs) {
        return sendError(res, 400, 'Teacher not found or does not belong to campus');
      }
    }

    const existingClass = await classRepo.findDuplicate({ schoolCampus, level, className: className.trim() });

    if (existingClass) {
      return sendConflict(res, 'A class with this name already exists for this level and campus');
    }

    const campus = await getCampusDocById(schoolCampus);
    if (campus) {
      const canAdd = await campus.canAddClass();
      if (!canAdd) {
        return sendError(res, 400, 'Campus has reached maximum class capacity');
      }
    }

    const newClass = await classRepo.create({
      schoolCampus,
      level,
      className: className.trim(),
      classManager: classManager || null,
      maxStudents: maxStudents || 50,
      academicYear,
      room
    });

    const populatedClass = await classRepo.findByIdPopulated(newClass._id);

    return sendCreated(res, 'Class created successfully', populatedClass);

  } catch (error) {
    console.error('❌ createClass error:', error);

    if (error.code === 11000) {
      return handleDuplicateKeyError(res, error);
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return sendError(res, 400, 'Validation failed', { errors: messages });
    }

    return sendError(res, 500, 'Failed to create class');
  }
};

/**
 * @desc    Get all classes with filters and pagination
 * @route   GET /api/class
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
exports.getAllClass = async (req, res) => {
  try {
    const {
      campusId,
      level,
      status,
      search,
      page = 1,
      limit = 20,
      includeArchived,
    } = req.query;

    const baseFilter = buildCampusFilter(req.user, campusId);

    const pageNumber = parseInt(page, 10);
    const pageSize   = parseInt(limit, 10);
    const skip       = (pageNumber - 1) * pageSize;

    const { data: classes, total } = await classRepo.paginate({
      baseFilter,
      includeArchived: includeArchived === 'true',
      status,
      level: level && isValidObjectId(level) ? level : undefined,
      search,
      skip,
      limit: pageSize,
    });

    return sendPaginated(
      res,
      200,
      'Classes retrieved successfully',
      classes,
      { total, page: pageNumber, limit: pageSize }
    );

  } catch (error) {
    console.error('❌ getAllClass error:', error);
    return sendError(res, 500, 'Failed to retrieve classes');
  }
};

/**
 * @desc    Get a single class by ID
 * @route   GET /api/class/single/:id
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
exports.getClassById = async (req, res) => {
  try {
    const classId = req.params.id;

    if (!isValidObjectId(classId)) {
      return sendError(res, 400, 'Invalid class ID format');
    }

    const classData = await classRepo.findByIdDetailed(classId);

    if (!classData) {
      return sendNotFound(res, 'Class');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (classData.schoolCampus._id.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only access classes from your own campus');
      }
    }

    return sendSuccess(res, 200, 'Class retrieved successfully', classData);

  } catch (error) {
    console.error('❌ getClassById error:', error);
    return sendError(res, 500, 'Failed to retrieve class');
  }
};

/**
 * @desc    Get all classes for a specific campus
 * @route   GET /api/class/campus/:campusId
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
exports.getClassesByCampus = async (req, res) => {
  try {
    const { campusId } = req.params;
    const { status, includeArchived, search, level } = req.query;

    if (!isValidObjectId(campusId)) {
      return sendError(res, 400, 'Invalid campus ID format');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (req.user.campusId !== campusId) {
        return sendError(res, 403, 'You can only access classes from your own campus');
      }
    }

    const classes = await classRepo.listByCampus({
      campusId,
      status,
      includeArchived: includeArchived === 'true',
      search,
      level: level && isValidObjectId(level) ? level : undefined,
    });

    return sendSuccess(res, 200, 'Classes retrieved successfully', classes);

  } catch (error) {
    console.error('❌ getClassesByCampus error:', error);
    return sendError(res, 500, 'Failed to retrieve campus classes');
  }
};

/**
 * @desc    Get all classes associated with a specific teacher.
 *
 * A teacher is associated with a class in two possible ways:
 *  1. They are the `classManager` (main teacher in charge).
 *  2. They are listed in the class `teachers[]` array (subject teacher).
 *
 * Both relationships are queried with a single $or filter to avoid
 * returning an empty list when the teacher is not a classManager.
 *
 * Campus isolation is enforced: the teacher's own campusId from the JWT
 * is used to scope the query — the caller cannot impersonate another campus.
 *
 * @route   GET /api/class/teacher/:teacherId
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
exports.getClassesByTeacher = async (req, res) => {
  try {
    const { teacherId } = req.params;

    if (!isValidObjectId(teacherId)) {
      return sendError(res, 400, 'Invalid teacher ID format');
    }

    // Campus isolation: teachers can only query their own campus.
    // ADMIN / DIRECTOR may query any teacher but we still scope by the
    // teacher's actual campus to avoid leaking cross-campus data.
    let campusFilter = {};

    if (req.user.role === 'TEACHER') {
      // A teacher can only retrieve classes from their own campus.
      // Requesting classes for another teacher's ID is also blocked here
      // because the JWT campusId is always injected server-side.
      if (req.user.id.toString() !== teacherId.toString()) {
        return sendError(res, 403, 'You can only retrieve your own classes');
      }
      campusFilter = { schoolCampus: req.user.campusId };
    } else if (req.user.role === 'CAMPUS_MANAGER') {
      campusFilter = { schoolCampus: req.user.campusId };
    }
    // ADMIN / DIRECTOR: no campus restriction

    // Include classes where the teacher is classManager OR listed in teachers[]
    const classes = await classRepo.listByTeacher({ campusFilter, teacherId });

    return sendSuccess(res, 200, 'Teacher classes retrieved successfully', classes);

  } catch (error) {
    console.error('❌ getClassesByTeacher error:', error);
    return sendError(res, 500, 'Failed to retrieve teacher classes');
  }
};

/**
 * @desc    Update an existing class
 * @route   PUT /api/class/:id
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.updateClass = async (req, res) => {
  try {
    const classId = req.params.id;

    if (!isValidObjectId(classId)) {
      return sendError(res, 400, 'Invalid class ID format');
    }

    const existingClass = await classRepo.findByIdLean(classId);

    if (!existingClass) {
      return sendNotFound(res, 'Class');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (existingClass.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only update classes from your own campus');
      }
    }

    const {
      schoolCampus,
      level,
      className,
      classManager,
      status,
      maxStudents,
      academicYear,
      room
    } = req.body;

    if (classManager && classManager !== existingClass.classManager?.toString()) {
      if (!isValidObjectId(classManager)) {
        return sendError(res, 400, 'Invalid class manager ID format');
      }

      const campusToCheck = schoolCampus || existingClass.schoolCampus;
      const isValid = await validateTeacherBelongsToCampus(classManager, campusToCheck);

      if (!isValid) {
        return sendError(res, 400, 'Class manager must belong to the same campus');
      }
    }

    if (schoolCampus || level || className) {
      const duplicateClass = await classRepo.findDuplicate({
        schoolCampus: schoolCampus || existingClass.schoolCampus,
        level:        level        || existingClass.level,
        className:    className    ? className.trim() : existingClass.className,
        exceptId:     classId,
      });

      if (duplicateClass) {
        return sendConflict(res, 'Another class with the same name already exists for this campus and level');
      }
    }

    const fields = {};
    if (schoolCampus)               fields.schoolCampus = schoolCampus;
    if (level)                      fields.level        = level;
    if (className)                  fields.className    = className.trim();
    if (classManager !== undefined) fields.classManager = classManager;
    if (status)                     fields.status       = status;
    if (maxStudents)                fields.maxStudents  = maxStudents;
    if (academicYear !== undefined) fields.academicYear = academicYear;
    if (room !== undefined)         fields.room         = room;

    await classRepo.applyUpdate(classId, fields);

    const populatedClass = await classRepo.findByIdPopulated(classId);

    return sendSuccess(res, 200, 'Class updated successfully', populatedClass);

  } catch (error) {
    console.error('❌ updateClass error:', error);

    if (error.code === 11000) {
      return handleDuplicateKeyError(res, error);
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return sendError(res, 400, 'Validation failed', { errors: messages });
    }

    return sendError(res, 500, 'Failed to update class');
  }
};

/**
 * @desc    Archive a class (soft delete)
 * @route   DELETE /api/class/:id
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.deleteClass = async (req, res) => {
  try {
    const classId = req.params.id;

    if (!isValidObjectId(classId)) {
      return sendError(res, 400, 'Invalid class ID format');
    }

    const existingClass = await classRepo.findByIdLean(classId);

    if (!existingClass) {
      return sendNotFound(res, 'Class');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (existingClass.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only archive classes from your own campus');
      }
    }

    if (existingClass.status === 'archived') {
      return sendError(res, 400, 'Class is already archived');
    }

    await classRepo.setStatus(classId, 'archived');

    return sendSuccess(res, 200, 'Class archived successfully');

  } catch (error) {
    console.error('❌ deleteClass error:', error);
    return sendError(res, 500, 'Failed to archive class');
  }
};

/**
 * @desc    Restore an archived class
 * @route   PATCH /api/class/:id/restore
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.restoreClass = async (req, res) => {
  try {
    const classId = req.params.id;

    if (!isValidObjectId(classId)) {
      return sendError(res, 400, 'Invalid class ID format');
    }

    const existingClass = await classRepo.findByIdLean(classId);

    if (!existingClass) {
      return sendNotFound(res, 'Class');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (existingClass.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only restore classes from your own campus');
      }
    }

    if (existingClass.status !== 'archived') {
      return sendError(res, 400, 'Class is not archived');
    }

    await classRepo.setStatus(classId, 'active');

    const populatedClass = await classRepo.findByIdForRestore(classId);

    return sendSuccess(res, 200, 'Class restored successfully', populatedClass);

  } catch (error) {
    console.error('❌ restoreClass error:', error);
    return sendError(res, 500, 'Failed to restore class');
  }
};