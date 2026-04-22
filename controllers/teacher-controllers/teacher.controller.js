const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const GenericEntityController = require('../genericEntity.controller');
const GenericBulkController = require('../genericBulk.controller');
const Teacher = require('../../models/teacher-models/teacher.model');
const Department = require('../../models/department.model');

const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../utils/responseHelpers');
const {
  isValidEmail,
  isValidObjectId,
  validatePasswordStrength,
} = require('../../utils/validationHelpers');
const { deleteFile } = require('../../utils/fileUpload');
const teacherConfig = require('../../configs/teacher.config');

const SALT_ROUNDS    = 10;
const TEACHEAR_FOLDER = 'teachers';
const JWT_SECRET      = process.env.JWT_SECRET;

// ========================================
// TEACHER CONFIGURATION
// ========================================
// Configuration for export
const exportConfig = {
  name: 'Teacher',
  columns: [
    { header: 'Matricule', key: 'matricule', width: 15 },
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Last Name', key: 'lastName', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Gender', key: 'gender', width: 10 },
    { header: 'Date of Birth', key: 'dateOfBirth', width: 15, format: 'date' },
    { header: 'Campus', key: 'schoolCampus.campus_name', width: 25 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Created At', key: 'createdAt', width: 20, format: 'date' },
  ],
  populateFields: [
    { path: 'schoolCampus', select: 'campus_name' },
    { path: 'department', select: 'name' },
  ],
};

// Configuration for import
const importConfig = {
  name: 'Teacher',
  requiredFields: ['firstName', 'lastName', 'email'],
  uniqueFields: ['email', 'matricule'],
  defaultValues: {
    status: 'active',
    gender: 'male',
  },
  fieldMapping: {
    'first_name': 'firstName',
    'last_name': 'lastName',
    'date_of_birth': 'dateOfBirth',
  },
  validators: {
    email: (value) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(value) || 'Invalid email format';
    },
    dateOfBirth: (value) => {
      const date = new Date(value);
      return !isNaN(date.getTime()) || 'Invalid date format';
    },
  },

  defaultPassword: 'Teacher@123T789',
  maxErrors: 100,
};

// ========================================
// INITIALIZE CONTROLLERS
// ========================================

//GenericEntityController: supports Multer format
const entityController = new GenericEntityController(teacherConfig);

const bulkController = new GenericBulkController(Teacher, {
  entityName: 'Teacher',
  RelatedModel: Department,
  relatedField: 'department',
  ...exportConfig,
  importRequiredFields: importConfig.requiredFields,
  importUniqueFields: importConfig.uniqueFields,
  importDefaultValues: importConfig.defaultValues,
  importFieldMapping: importConfig.fieldMapping,
  importValidators: importConfig.validators,
  importTransformer: importConfig.transformer,
  defaultPassword: importConfig.defaultPassword,
  maxImportErrors: importConfig.maxErrors,
});

// ========================================
// CUSTOM TEACHER LOGIN
// ========================================

/**
 * Teacher login
 * @route   POST /api/teacher/login
 * @access  Public
 */
const loginTeacher = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required');
    }

    // JWT_SECRET verification
    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET is not defined');
      return sendError(res, 500, 'Server configuration error');
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format');
    }

    // Find teacher with password field
    const teacher = await Teacher.findOne({ 
      email: email.toLowerCase() 
    })
    .select('+password')
    .populate('department', 'name')
    .populate('subjects', 'subject_name')
    .populate('schoolCampus', 'campus_name');

    // Generic error for security
    if (!teacher) {
      return sendError(res, 401, 'Invalid credentials');
    }

    // Compare password
    const isPasswordValid = await bcrypt.compare(password, teacher.password);
    if (!isPasswordValid) {
      return sendError(res, 401, 'Invalid credentials');
    }

    // Check account status
    if (teacher.status !== 'active') {
      return sendError(res, 403, 'Account is inactive or suspended. Please contact support');
    }

    

    // Generate JWT token — issuer must match auth.js verification options
    const token = jwt.sign(
      { 
        id: teacher._id,
        campusId: teacher.schoolCampus._id,
        role: 'TEACHER',
        name: `${teacher.firstName} ${teacher.lastName}`,
        departmentId: teacher.department?._id
      },
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'school-management-app' }
    );

    // Update last login
    await Teacher.updateOne(
      { _id: teacher._id },
      { $set: { lastLogin: new Date() } }
    );

    return sendSuccess(res, 200, 'Login successful', {
      token,
      user: {
        id: teacher._id,
        name: `${teacher.firstName} ${teacher.lastName}`,
        email: teacher.email,
        username: teacher.username,
        phone: teacher.phone,
        profileImage: teacher.profileImage,
        role: 'TEACHER',
        department: teacher.department?.name,
        campus: teacher.schoolCampus?.campus_name,
      }
    });

  } catch (error) {
    console.error('❌ Teacher login error:', error);
    return sendError(res, 500, 'Internal server error during login');
  }
};

/**
   * Update teacher password
   * @route   PATCH /api/teachers/:id/password
   * @access  Private (Teachers themselves or ADMIN)
   */
const updateTeacherPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid teacher ID format');
    }

    // Validate new password
    if (!newPassword) {
      return sendError(res, 400, 'New password is required');
    }

    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return sendError(res, 400, 'Password does not meet requirements', {
        errors: passwordValidation.errors
      });
    }

    // Authorization
    const isOwner = req.user?.id === id;
    const isAdmin = ['ADMIN', 'CAMPUS_MANAGER', 'DIRECTOR'].includes(req.user?.role);

    if (!isOwner && !isAdmin) {
      return sendError(res, 403, 'You are not authorized to change this password');
    }

    // Fetch teacher with password
    const teacher = await Teacher.findById(id).select('+password');
    if (!teacher) {
      return sendNotFound(res, 'teacher');
    }

    // Verify current password (skip for ADMIN)
    if (!isAdmin) {
      if (!currentPassword) {
        return sendError(res, 400, 'Current password is required');
      }

      const isMatch = await bcrypt.compare(currentPassword, teacher.password);
      if (!isMatch) {
        return sendError(res, 401, 'Current password is incorrect');
      }
    }

    // Hash new password
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    teacher.password = await bcrypt.hash(newPassword, salt);

    await teacher.save();

    return sendSuccess(res, 200, 'Password updated successfully');

  } catch (error) {
    console.error('❌ Password update error:', error);
    return sendError(res, 500, 'Failed to update password');
  }
};


/**
   * Restore archived teacher
   * @route   PATCH /api/teachers/:id/restore
   * @access  Private (ADMIN, CAMPUS_MANAGER, DIRECTOR)
   */
const restoreTeacher= async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid teacher ID format');
    }

    const teacher = await Teacher.findById(id);
    if (!teacher) {
      return sendNotFound(res, 'Teacher');
    }

    // Authorization
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (teacher.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only restore teachers from your own campus');
      }
    }

    // Update status to active
    teacher.status = 'active';
    await teacher.save();

    return sendSuccess(res, 200, 'Seacher restored successfully');

  } catch (error) {
    console.error('❌ Error restoring teacher:', error);
    return sendError(res, 500, 'Failed to restore teacher');
  }
};

/**
 * Permanently delete teacher
 * @route   DELETE /api/teachers/:id/permanent
 * @access  Private (ADMIN only)
 */
const deleteTeacherPermanently = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid teacher ID format');
    }

    const teacher = await Teacher.findById(id);
    if (!teacher) {
      return sendNotFound(res, 'Teacher');
    }

    // Delete profile image if exists
    if (teacher.profileImage) {
      await deleteFile(TEACHEAR_FOLDER, teacher.profileImage);
    }

    // Delete teacher from database
    await Teacher.findByIdAndDelete(id);

    return sendSuccess(res, 200, 'Teacher deleted permanently');

  } catch (error) {
    console.error('❌ Error deleting teacher:', error);
    return sendError(res, 500, 'Failed to delete teacher');
  }
};
// ========================================
// EXPORTS
// ========================================

module.exports = {

  // Generic CRUD operations (automatically handle Multer format)
  createTeacher: entityController.create,
  getAllTeachers: entityController.getAll,
  getOneTeacher: entityController.getOne,
  updateTeacher: entityController.update,
  archiveTeacher: entityController.archive,
  getTeacherStats: entityController.getStats,
  
  // Bulk operations
  bulkChangeDepartment: bulkController.bulkChangeRelated,
  bulkSendEmail: bulkController.bulkSendEmail,
  bulkArchive: bulkController.bulkArchive,
  exportToCSV: bulkController.exportToCSV,
  exportToExcel: bulkController.exportToExcel,
  importFromFile: bulkController.importFromFile,
  getImportTemplateCSV: bulkController.getImportTemplateCSV,
  getImportTemplateExcel: bulkController.getImportTemplateExcel,
  
  // Custom login
  loginTeacher,

  //Forgot password
  updateTeacherPassword,

  //Restore Archived Teacher
  restoreTeacher,

  //Delete Teacher Permanently
  deleteTeacherPermanently
};