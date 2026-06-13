const Subject = require('../subject.model');
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
  escapeRegex,
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
    const existingSubject = await Subject.findOne({
      schoolCampus,
      subject_code: subject_code.toUpperCase().trim()
    });

    if (existingSubject) {
      return sendConflict(res, 'A subject with this code already exists in this campus');
    }

    // Create the subject
    const newSubject = await Subject.create({
      schoolCampus,
      subject_name: subject_name.trim(),
      subject_code: subject_code.toUpperCase().trim(),
      description,
      coefficient: coefficient || 1,
      color: color || '#1976d2',
      category: category || 'Other'
    });

    // Populate for response
    const populatedSubject = await Subject.findById(newSubject._id)
      .populate('schoolCampus', 'campus_name')
      .lean();

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
      page = 1,
      limit = 50,
      includeArchived,
    } = req.query;

    // Build campus filter based on user role
    const filter = buildCampusFilter(req.user, campusId);

    if (includeArchived !== 'true') {
      // Defensive filter: excludes archived docs even if status field is missing.
      // Never allows status=archived to pass when toggle is off.
      filter.status = { $ne: 'archived' };
    } else if (status && ['active', 'archived'].includes(status)) {
      filter.status = status;
    }
    

    // Category filter
    if (category) {
      filter.category = category;
    }

    // Search by name or code
    if (search) {
      filter.$or = [
        { subject_name: { $regex: escapeRegex(search), $options: 'i' } },
        { subject_code: { $regex: escapeRegex(search), $options: 'i' } }
      ];
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100); // Max 100
    const skip = (pageNum - 1) * limitNum;

    // Fetch subjects
    const subjects = await Subject.find(filter)
      .sort({ subject_name: 1 })
      .skip(skip)
      .limit(limitNum)
      .populate('schoolCampus', 'campus_name')
      .lean();

    const total = await Subject.countDocuments(filter);

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
    const subject = await Subject.findById(subjectId)
      .populate('schoolCampus', 'campus_name location')
      .lean();

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
    const existingSubject = await Subject.findById(subjectId);

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
      const duplicateSubject = await Subject.findOne({
        _id: { $ne: subjectId },
        schoolCampus: existingSubject.schoolCampus,
        subject_code: subject_code.toUpperCase().trim()
      });

      if (duplicateSubject) {
        return sendConflict(res, 'Another subject with this code already exists in this campus');
      }
    }

    // Update fields
    if (subject_name) existingSubject.subject_name = subject_name.trim();
    if (subject_code) existingSubject.subject_code = subject_code.toUpperCase().trim();
    if (description !== undefined) existingSubject.description = description;
    if (coefficient !== undefined) existingSubject.coefficient = coefficient;
    if (color) existingSubject.color = color;
    if (category) existingSubject.category = category;

    // Save
    const updatedSubject = await existingSubject.save();

    // Populate for response
    const populatedSubject = await Subject.findById(updatedSubject._id)
      .populate('schoolCampus', 'campus_name')
      .lean();

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
    const subject = await Subject.findById(subjectId);

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
    subject.status = 'archived';
    await subject.save();

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
    const subject = await Subject.findById(subjectId);

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
    subject.status = 'active';
    await subject.save();

    // Populate for response
    const populatedSubject = await Subject.findById(subject._id)
      .populate('schoolCampus', 'campus_name')
      .lean();

    return sendSuccess(res, 200, 'Subject restored successfully', populatedSubject);

  } catch (error) {
    console.error('❌ restoreSubject error:', error);
    return sendError(res, 500, 'Failed to restore subject');
  }
};