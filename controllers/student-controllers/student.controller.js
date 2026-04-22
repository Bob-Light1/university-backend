const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const GenericEntityController = require('../genericEntity.controller');
const GenericBulkController = require('../genericBulk.controller');
const Student = require('../../models/student-models/student.model');
const Class = require('../../models/class.model');
const studentConfig = require('../../configs/student.config');

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

const SALT_ROUNDS    = 10;
const STUDENT_FOLDER = 'students';

const JWT_SECRET = process.env.JWT_SECRET;

// ========================================
// CONFIGURATIONS
// ========================================

// Configuration for export
const exportConfig = {
  name: 'Student',
  columns: [
    { header: 'Matricule', key: 'matricule', width: 15 },
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Last Name', key: 'lastName', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Gender', key: 'gender', width: 10 },
    { header: 'Date of Birth', key: 'dateOfBirth', width: 15, format: 'date' },
    { header: 'Class', key: 'studentClass.className', width: 20 },
    { header: 'Campus', key: 'schoolCampus.campus_name', width: 25 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Created At', key: 'createdAt', width: 20, format: 'date' },
  ],
  populateFields: [
    { path: 'studentClass', select: 'className' },
    { path: 'schoolCampus', select: 'campus_name' },
  ],
  classField: 'studentClass',
};

// Configuration for import
const importConfig = {
  name: 'Student',
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
  transformer: (data, row) => {
    // Custom transformation
    if (row.class_name) {
      // TODO: Lookup class by name and set studentClass
    }
    return data;
  },
  defaultPassword: 'Student@123',
  maxErrors: 100,
};


// ========================================
// INITIALIZE CONTROLLERS
// ========================================

// GenericEntityController: supports Multer format
const entityController = new GenericEntityController(studentConfig);

const bulkController = new GenericBulkController(Student, {
  entityName: 'Student',
  RelatedModel: Class,
  relatedField: 'studentClass',
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
// CUSTOM STUDENT LOGIN
// ========================================

/**
 * Student login
 * @route   POST /api/students/login
 * @access  Public
 */
const loginStudent = async (req, res) => {
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

    // Find student with password field
    const student = await Student.findOne({ 
      email: email.toLowerCase() 
    })
    .select('+password')
    .populate('schoolCampus', 'campus_name');;

    // Generic error for security
    if (!student) {
      return sendError(res, 401, 'Invalid credentials');
    }

    // Compare password
    const isPasswordValid = await bcrypt.compare(password, student.password);
    if (!isPasswordValid) {
      return sendError(res, 401, 'Invalid credentials');
    }

    // Check account status
    if (student.status !== 'active') {
      return sendError(res, 403, 'Account is inactive or suspended. Please contact support');
    }

    // schoolCampus may be a populated object ({ _id, campus_name }) due to the
    // .populate() call above. JWT.sign serialises objects as-is, so campusId
    // would become { _id, campus_name } instead of a plain ObjectId string.
    // buildCampusFilter (validationHelpers) calls isValidObjectId(campusId) and
    // rejects non-string values → 403. Always extract the raw _id here.
    const campusId = student.schoolCampus?._id ?? student.schoolCampus;

    // Generate JWT token — issuer must match auth.js verification options
    const token = jwt.sign(
      {
        id:       student._id,
        campusId, // plain ObjectId string — required by buildCampusFilter
        classId:  student.studentClass ?? null, // useful for attendance scoping
        role:     'STUDENT',
        name:     `${student.firstName} ${student.lastName}`,
      },
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'school-management-app' }
    );

    // Update last login
    student.lastLogin = new Date();
    await student.save();

    return sendSuccess(res, 200, 'Login successful', {
      token,
      user: {
        id:           student._id,
        campusId,     // exposed to frontend — needed by ResultStudent, useResult, etc.
        classId:      student.studentClass ?? null,
        name:         `${student.firstName} ${student.lastName}`,
        email:        student.email,
        username:     student.username,
        phone:        student.phone,
        profileImage: student.profileImage,
        role:         'STUDENT',
      },
    });

  } catch (error) {
    console.error('❌ Student login error:', error);
    return sendError(res, 500, 'Internal server error during login');
  }
};

 /**
   * Update student password
   * @route   PATCH /api/students/:id/password
   * @access  Private (Students themselves or ADMIN)
   */
 const updateStudentPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid student ID format');
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

    // Fetch student with password
    const student = await Student.findById(id).select('+password');
    if (!student) {
      return sendNotFound(res, 'Student');
    }

    // Verify current password (skip for ADMIN)
    if (!isAdmin) {
      if (!currentPassword) {
        return sendError(res, 400, 'Current password is required');
      }

      const isMatch = await bcrypt.compare(currentPassword, student.password);
      if (!isMatch) {
        return sendError(res, 401, 'Current password is incorrect');
      }
    }

    // Hash new password
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    student.password = await bcrypt.hash(newPassword, salt);

    await student.save();

    return sendSuccess(res, 200, 'Password updated successfully');

  } catch (error) {
    console.error('❌ Password update error:', error);
    return sendError(res, 500, 'Failed to update password');
  }
};

/**
   * Restore archived student
   * @route   PATCH /api/students/:id/restore
   * @access  Private (ADMIN, CAMPUS_MANAGER, DIRECTOR)
   */
const restoreStudent= async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid student ID format');
    }

    const student = await Student.findById(id);
    if (!student) {
      return sendNotFound(res, 'Student');
    }

    // Authorization
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (student.schoolCampus.toString() !== req.user.campusId) {
        return sendError(res, 403, 'You can only restore students from your own campus');
      }
    }

    // Update status to active
    student.status = 'active';
    await student.save();

    return sendSuccess(res, 200, 'Student restored successfully');

  } catch (error) {
    console.error('❌ Error restoring student:', error);
    return sendError(res, 500, 'Failed to restore student');
  }
};

/**
 * Permanently delete student
 * @route   DELETE /api/students/:id/permanent
 * @access  Private (ADMIN only)
 */
const deleteStudentPermanently = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid student ID format');
    }

    const student = await Student.findById(id);
    if (!student) {
      return sendNotFound(res, 'Student');
    }

    // Delete profile image if exists
    if (student.profileImage) {
      await deleteFile(STUDENT_FOLDER, student.profileImage);
    }

    // Delete student from database
    await Student.findByIdAndDelete(id);

    return sendSuccess(res, 200, 'Student deleted permanently');

  } catch (error) {
    console.error('❌ Error deleting student:', error);
    return sendError(res, 500, 'Failed to delete student');
  }
};

// ========================================
// EXPORTS
// ========================================

module.exports = {
  
  // Generic CRUD operations (automatically handle Multer format)
  createStudent: entityController.create,
  getAllStudents: entityController.getAll,
  getOneStudent: entityController.getOne,
  updateStudent: entityController.update,
  archiveStudent: entityController.archive,
  getStudentStats: entityController.getStats,

  // Bulk operations
  bulkChangeClass: bulkController.bulkChangeRelated,
  bulkSendEmail: bulkController.bulkSendEmail,
  bulkArchive: bulkController.bulkArchive,
  exportToCSV: bulkController.exportToCSV,
  exportToExcel: bulkController.exportToExcel,
  importFromFile: bulkController.importFromFile,
  getImportTemplateCSV: bulkController.getImportTemplateCSV,
  getImportTemplateExcel: bulkController.getImportTemplateExcel,
  
  // Custom login
  loginStudent,

  //update Student Password
  updateStudentPassword,

  //Restore Archived Student
  restoreStudent,

  //Delete Student Permanently 
  deleteStudentPermanently
};