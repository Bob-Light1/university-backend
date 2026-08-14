const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const GenericEntityController = require('../../../shared/lib/generic-entity.controller');
const GenericBulkController = require('../../../shared/lib/generic-bulk.controller');
const Student = require('../models/student.model'); // deliberate exception: Model for GenericBulkController
const studentRepo = require('../student.repository');
const classService = require('../../class').service; // class module facade (§3)
const studentConfig = require('../student.config');

const profileSvc = require('../../../shared/services/profile.service');

const {
  sendSuccess,
  sendError,
  sendForbidden,
} = require('../../../shared/utils/response-helpers');
const {
  isValidEmail,
  isValidObjectId,
  buildCampusFilter,
} = require('../../../shared/utils/validation-helpers');
const { getLoginPrefs } = require('../../settings').service;
const hardDelete = require('../../../shared/lib/hard-delete');

/** Roles allowed to reset another account's password — scoped by buildCampusFilter. */
const MANAGEMENT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];


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
  findRelatedById: classService.findClassForBulk,
  relatedField: 'studentClass',
  ...exportConfig,
  importRequiredFields: importConfig.requiredFields,
  importUniqueFields: importConfig.uniqueFields,
  importDefaultValues: importConfig.defaultValues,
  importFieldMapping: importConfig.fieldMapping,
  importValidators: importConfig.validators,
  importTransformer: importConfig.transformer,
  defaultPassword: importConfig.defaultPassword,
  activation: { userModel: 'Student' },
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
    const { email, username, password } = req.body;

    if ((!email && !username) || !password) {
      return sendError(res, 400, 'Email (or username) and password are required.');
    }

    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET is not defined');
      return sendError(res, 500, 'Server configuration error.');
    }

    const query = email
      ? { email: email.toLowerCase().trim() }
      : { username: username.toLowerCase().trim() };

    if (email && !isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format.');
    }

    const student = await studentRepo.findStudentForLogin(query);

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

    // Update last login (atomic: does not trigger save hooks)
    await studentRepo.touchLastLogin(student._id);

    const prefs = await getLoginPrefs(student._id, 'STUDENT', campusId);

    return sendSuccess(res, 200, 'Login successful', {
      token,
      user: {
        id:           student._id,
        campusId,
        classId:      student.studentClass ?? null,
        name:         `${student.firstName} ${student.lastName}`,
        email:        student.email,
        username:     student.username,
        phone:        student.phone,
        profileImage: student.profileImage,
        role:         'STUDENT',
        ...prefs,
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
   * @access  Private (the student themselves, or a management role WITHIN THEIR CAMPUS)
   */
 const updateStudentPassword = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid student ID format');
    }

    const actorIsTarget = req.user?.id === id;
    const isManager     = MANAGEMENT_ROLES.includes(req.user?.role);

    if (!actorIsTarget && !isManager) {
      return sendForbidden(res, 'You are not authorized to change this password');
    }

    // Campus scope, derived — never inlined (CLAUDE.md §2). This is the control
    // that was missing: the target used to be resolved by bare `_id`, so a
    // CAMPUS_MANAGER could reset a student's password on ANY campus (B6-③, the
    // twin of the teacher controller's defect).
    let campusFilter;
    try {
      campusFilter = buildCampusFilter(req.user);
    } catch {
      return sendForbidden(res, 'Campus access denied');
    }

    return profileSvc.resetManagedPassword(
      res,
      Student,
      { _id: id, ...campusFilter },
      req.body,
      { actorIsTarget },
    );

  } catch (error) {
    console.error('❌ Password update error:', error);
    return sendError(res, 500, 'Failed to update password');
  }
};

/**
 * Permanently delete a student.
 *
 * Compatibility alias for `DELETE /api/danger-zone/student/:id` — the removal itself, the
 * cascade policy and the four confirmation controls all live in the harmonized hard-delete
 * service (CLAUDE.md §5.2). The impact preview that issues the required ticket is served by
 * `GET /api/danger-zone/student/:id/impact`.
 *
 * @route   DELETE /api/students/:id/permanent
 * @access  Private (ADMIN only)
 */
const deleteStudentPermanently = async (req, res) => {
  try {
    const receipt = await hardDelete.service.execute({
      entityType: 'student',
      entityId:   req.params.id,
      req,
      confirmation: {
        ticket:             req.body?.ticket,
        confirmationPhrase: req.body?.confirmationPhrase,
        password:           req.body?.password,
        reason:             req.body?.reason,
      },
    });

    return sendSuccess(res, 200, 'Student deleted permanently', receipt);

  } catch (error) {
    return hardDelete.respondToError(res, error);
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
  restoreStudent: entityController.restore,

  //Delete Student Permanently 
  deleteStudentPermanently
};