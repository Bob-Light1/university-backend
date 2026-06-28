const subjectRepo = require('../subject.repository');
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

/**
 * @desc    Create a new subject
 * @route   POST /api/subject
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.createSubject = async (req, res) => {
  try {
    const {
      schoolCampus,
      subject_name,
      subject_code,
      description,
      coefficient,
      color,
      category
    } = req.body;

    // Validate required fields
    if (!schoolCampus || !subject_name || !subject_code) {
      return sendError(res, 400, 'Campus, subject name, and subject code are required');
    }

    // Validate ObjectId
    if (!isValidObjectId(schoolCampus)) {
      return sendError(res, 400, 'Invalid campus ID format');
    }

    // Campus isolation enforcement : CAMPUS_MANAGER can only create subjects in their own campus
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (req.user.campusId !== schoolCampus) {
        return sendError(res, 403, 'You can only create subjects in your own campus');
      }
    }

    // Check for duplicate subject code in the same campus
    const existingSubject = await subjectRepo.findDuplicateCode(
      schoolCampus,
      subject_code.toUpperCase().trim(),
    );

    if (existingSubject) {
      return sendConflict(res, 'A subject with this code already exists in this campus');
    }

    // Create the subject
    const newSubject = await subjectRepo.create({
      schoolCampus,
      subject_name: subject_name.trim(),
      subject_code: subject_code.toUpperCase().trim(),
      description,
      coefficient: coefficient || 1,
      color: color || '#1976d2',
      category: category || 'Other'
    });

    // Populate for response
    const populatedSubject = await subjectRepo.findByIdForResponse(newSubject._id);

    return sendCreated(res, 'Subject created successfully', populatedSubject);

  } catch (error) {
    console.error('❌ createSubject error:', error);

    // Handle duplicate key errors
    if (error.code === 11000) {
      return sendConflict(res, 'Subject code already exists for this campus');
    }

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return sendError(res, 400, 'Validation failed', { errors: messages });
    }

    return sendError(res, 500, 'Failed to create subject');
  }
};

/**
 * @desc    Get all subjects with filters and pagination
 * @route   GET /api/subject
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
exports.getSubjects = async (req, res) => {
  try {
    const {
      campusId,
      status,
      category,
      search,
      teacher,
      page = 1,
      limit = 50,
      includeArchived,
    } = req.query;

    // Build campus filter based on user role
    const baseFilter = buildCampusFilter(req.user, campusId);

    // Optional teacher scope (subjects taught by this teacher). Ignored when the
    // value is not a valid ObjectId so a malformed param cannot break the query.
    const teacherFilter = teacher && isValidObjectId(teacher) ? teacher : undefined;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100); // Max 100
    const skip = (pageNum - 1) * limitNum;

    const { data: subjects, total } = await subjectRepo.paginate({
      baseFilter,
      includeArchived: includeArchived === 'true',
      status,
      category,
      search,
      teacher: teacherFilter,
      skip,
      limit: limitNum,
    });

    return sendPaginated(
      res,
      200,
      'Subjects retrieved successfully',
      subjects,
      { total, page: pageNum, limit: limitNum }
    );

  } catch (error) {
    console.error('❌ getSubjects error:', error);
    return sendError(res, 500, 'Failed to retrieve subjects');
  }
};

/**
 * @desc    Get subject by ID
 * @route   GET /api/subject/:id
 * @access  ADMIN, DIRECTOR,
 */
exports.getSubjectById = async (req, res) => {
  try {
    const subjectId = req.params.id;

    // Validate ObjectId
    if (!isValidObjectId(subjectId)) {
      return sendError(res, 400, 'Invalid subject ID format');
    }

    // Find subject
    const subject = await subjectRepo.findByIdDetailed(subjectId);

    if (!subject) {
      return sendNotFound(res, 'Subject');
    }

    // Campus isolation check
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (subject.schoolCampus._id.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only access subjects from your own campus');
      }
    }

    return sendSuccess(res, 200, 'Subject retrieved successfully', subject);

  } catch (error) {
    console.error('❌ getSubjectById error:', error);
    return sendError(res, 500, 'Failed to retrieve subject');
  }
};

/**
 * @desc    Update subject
 * @route   PUT /api/subject/:id
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.updateSubject = async (req, res) => {
  try {
    const subjectId = req.params.id;

    // Validate ObjectId
    if (!isValidObjectId(subjectId)) {
      return sendError(res, 400, 'Invalid subject ID format');
    }

    // Find existing subject
    const existingSubject = await subjectRepo.findByIdLean(subjectId);

    if (!existingSubject) {
      return sendNotFound(res, 'Subject');
    }

    // Campus isolation check
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (existingSubject.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only update subjects from your own campus');
      }
    }

    const {
      subject_name,
      subject_code,
      description,
      coefficient,
      color,
      category
    } = req.body;

    // Check for duplicate subject code (if being changed)
    if (subject_code && subject_code.toUpperCase() !== existingSubject.subject_code) {
      const duplicateSubject = await subjectRepo.findDuplicateCodeExcept(
        existingSubject.schoolCampus,
        subject_code.toUpperCase().trim(),
        subjectId,
      );

      if (duplicateSubject) {
        return sendConflict(res, 'Another subject with this code already exists in this campus');
      }
    }

    // Build the set of fields actually provided (partial update semantics).
    const fields = {};
    if (subject_name) fields.subject_name = subject_name.trim();
    if (subject_code) fields.subject_code = subject_code.toUpperCase().trim();
    if (description !== undefined) fields.description = description;
    if (coefficient !== undefined) fields.coefficient = coefficient;
    if (color) fields.color = color;
    if (category) fields.category = category;

    // Save
    const updatedSubject = await subjectRepo.updateById(subjectId, fields);
    if (!updatedSubject) return sendNotFound(res, 'Subject');

    // Populate for response
    const populatedSubject = await subjectRepo.findByIdForResponse(updatedSubject._id);

    return sendSuccess(res, 200, 'Subject updated successfully', populatedSubject);

  } catch (error) {
    console.error('❌ updateSubject error:', error);

    if (error.code === 11000) {
      return handleDuplicateKeyError(res, error);
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return sendError(res, 400, 'Validation failed', { errors: messages });
    }

    return sendError(res, 500, 'Failed to update subject');
  }
};

/**
 * @desc    Archive subject (soft delete)
 * @route   DELETE /api/subject/:id
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.deleteSubject = async (req, res) => {
  try {
    const subjectId = req.params.id;

    // Validate ObjectId
    if (!isValidObjectId(subjectId)) {
      return sendError(res, 400, 'Invalid subject ID format');
    }

    // Find subject
    const subject = await subjectRepo.findByIdLean(subjectId);

    if (!subject) {
      return sendNotFound(res, 'Subject');
    }

    // Campus isolation check
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (subject.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only archive subjects from your own campus');
      }
    }

    // Check if already archived
    if (subject.status === 'archived') {
      return sendError(res, 400, 'Subject is already archived');
    }

    // Archive
    await subjectRepo.setStatus(subjectId, 'archived');

    return sendSuccess(res, 200, 'Subject archived successfully');

  } catch (error) {
    console.error('❌ deleteSubject error:', error);
    return sendError(res, 500, 'Failed to archive subject');
  }
};

/**
 * @desc    Restore archived subject
 * @route   PATCH /api/subject/:id/restore
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
exports.restoreSubject = async (req, res) => {
  try {
    const subjectId = req.params.id;

    // Validate ObjectId
    if (!isValidObjectId(subjectId)) {
      return sendError(res, 400, 'Invalid subject ID format');
    }

    // Find subject
    const subject = await subjectRepo.findByIdLean(subjectId);

    if (!subject) {
      return sendNotFound(res, 'Subject');
    }

    // Campus isolation check
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (subject.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only restore subjects from your own campus');
      }
    }

    // Check if not archived
    if (subject.status !== 'archived') {
      return sendError(res, 400, 'Subject is already active');
    }

    // Restore
    await subjectRepo.setStatus(subjectId, 'active');

    // Populate for response
    const populatedSubject = await subjectRepo.findByIdForResponse(subjectId);

    return sendSuccess(res, 200, 'Subject restored successfully', populatedSubject);

  } catch (error) {
    console.error('❌ restoreSubject error:', error);
    return sendError(res, 500, 'Failed to restore subject');
  }
};
