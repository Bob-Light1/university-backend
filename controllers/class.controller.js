const Class = require('../models/class.model');
const Teacher = require('../models/teacher-models/teacher.model');
const Campus = require('../models/campus.model');
const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendConflict,
  sendPaginated,
  handleDuplicateKeyError
} = require('../utils/responseHelpers');
const {
  isValidObjectId,
  validateTeacherBelongsToCampus,
  buildCampusFilter
} = require('../utils/validationHelpers');

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

      const teacher = await Teacher.findOne({
        _id: classManager,
        schoolCampus: schoolCampus
      }).select('_id');

      if (!teacher) {
        return sendError(res, 400, 'Teacher not found or does not belong to campus');
      }
    }

    const existingClass = await Class.findOne({
      schoolCampus,
      level,
      className: className.trim()
    });

    if (existingClass) {
      return sendConflict(res, 'A class with this name already exists for this level and campus');
    }

    const campus = await Campus.findById(schoolCampus);
    if (campus) {
      const canAdd = await campus.canAddClass();
      if (!canAdd) {
        return sendError(res, 400, 'Campus has reached maximum class capacity');
      }
    }

    const newClass = await Class.create({
      schoolCampus,
      level,
      className: className.trim(),
      classManager: classManager || null,
      maxStudents: maxStudents || 50,
      academicYear,
      room
    });

    const populatedClass = await Class.findById(newClass._id)
      .populate('schoolCampus', 'campus_name')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email')
      .lean();

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

    const filter = buildCampusFilter(req.user, campusId);

    if (includeArchived !== 'true') {
      filter.status = { $ne: 'archived' };
    } else if (status) {
      filter.status = status;
    }

    if (level && isValidObjectId(level)) {
      filter.level = level;
    }

    if (search) {
      filter.className = { $regex: search, $options: 'i' };
    }

    const pageNumber = parseInt(page, 10);
    const pageSize   = parseInt(limit, 10);
    const skip       = (pageNumber - 1) * pageSize;

    const classes = await Class.find(filter)
      .populate('schoolCampus', 'campus_name')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    const total = await Class.countDocuments(filter);

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

    const classData = await Class.findById(classId)
      .populate('schoolCampus', 'campus_name campus_number location')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email phone')
      .populate('students', 'firstName lastName email')
      .lean();

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
    const { status, includeArchived } = req.query;

    if (!isValidObjectId(campusId)) {
      return sendError(res, 400, 'Invalid campus ID format');
    }

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (req.user.campusId !== campusId) {
        return sendError(res, 403, 'You can only access classes from your own campus');
      }
    }

    const filter = { schoolCampus: campusId };
    if (includeArchived !== 'true') {
      filter.status = 'active';
    } else if (status) {
      filter.status = status;
    }

    const classes = await Class.find(filter)
      .populate('schoolCampus', 'campus_name email')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email')
      .sort({ level: 1, className: 1 })
      .lean();

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
    const filter = {
      ...campusFilter,
      status: { $ne: 'archived' },
      $or: [
        { classManager: teacherId },
        { teachers:     teacherId },
      ],
    };

    const classes = await Class.find(filter)
      .populate('schoolCampus', 'campus_name')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email')
      .sort({ className: 1 })
      .lean();

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

    const existingClass = await Class.findById(classId);

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
      const duplicateClass = await Class.findOne({
        _id: { $ne: classId },
        schoolCampus: schoolCampus || existingClass.schoolCampus,
        level:        level        || existingClass.level,
        className:    className    ? className.trim() : existingClass.className
      });

      if (duplicateClass) {
        return sendConflict(res, 'Another class with the same name already exists for this campus and level');
      }
    }

    if (schoolCampus)              existingClass.schoolCampus = schoolCampus;
    if (level)                     existingClass.level        = level;
    if (className)                 existingClass.className    = className.trim();
    if (classManager !== undefined) existingClass.classManager = classManager;
    if (status)                    existingClass.status       = status;
    if (maxStudents)               existingClass.maxStudents  = maxStudents;
    if (academicYear !== undefined) existingClass.academicYear = academicYear;
    if (room !== undefined)         existingClass.room         = room;

    const updatedClass = await existingClass.save();

    const populatedClass = await Class.findById(updatedClass._id)
      .populate('schoolCampus', 'campus_name')
      .populate('level', 'name description')
      .populate('classManager', 'firstName lastName email')
      .lean();

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

    const existingClass = await Class.findById(classId);

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

    existingClass.status = 'archived';
    await existingClass.save();

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

    const existingClass = await Class.findById(classId);

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

    existingClass.status = 'active';
    await existingClass.save();

    const populatedClass = await Class.findById(existingClass._id)
      .populate('schoolCampus', 'campus_name')
      .populate('level', 'name description')
      .lean();

    return sendSuccess(res, 200, 'Class restored successfully', populatedClass);

  } catch (error) {
    console.error('❌ restoreClass error:', error);
    return sendError(res, 500, 'Failed to restore class');
  }
};