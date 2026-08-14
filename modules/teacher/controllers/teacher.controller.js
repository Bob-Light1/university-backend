const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const GenericEntityController = require('../../../shared/lib/generic-entity.controller');
const GenericBulkController = require('../../../shared/lib/generic-bulk.controller');
const Teacher = require('../models/teacher.model'); // accepted exception: Model of the GenericBulkController
const teacherRepo = require('../teacher.repository');
const departmentService = require('../../department').service; // department module facade (§3)

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

const teacherConfig = require('../teacher.config');
const { getLoginPrefs } = require('../../settings').service;
const hardDelete = require('../../../shared/lib/hard-delete');

/** Roles allowed to reset another account's password — scoped by buildCampusFilter. */
const MANAGEMENT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

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
  findRelatedById: departmentService.findDepartmentForBulk,
  relatedField: 'department',
  ...exportConfig,
  importRequiredFields: importConfig.requiredFields,
  importUniqueFields: importConfig.uniqueFields,
  importDefaultValues: importConfig.defaultValues,
  importFieldMapping: importConfig.fieldMapping,
  importValidators: importConfig.validators,
  importTransformer: importConfig.transformer,
  defaultPassword: importConfig.defaultPassword,
  activation: { userModel: 'Teacher' },
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

    const teacher = await teacherRepo.findTeacherForLogin(query);

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
    await teacherRepo.touchLastLogin(teacher._id);

    const prefs = await getLoginPrefs(teacher._id, 'TEACHER', teacher.schoolCampus?._id ?? null);

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
        ...prefs,
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
   * @access  Private (the teacher themselves, or a management role WITHIN THEIR CAMPUS)
   */
const updateTeacherPassword = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid teacher ID format');
    }

    const actorIsTarget = req.user?.id === id;
    const isManager     = MANAGEMENT_ROLES.includes(req.user?.role);

    if (!actorIsTarget && !isManager) {
      return sendForbidden(res, 'You are not authorized to change this password');
    }

    // Campus scope, derived — never inlined (CLAUDE.md §2). This is the control
    // that was missing: the target used to be resolved by bare `_id`, so a
    // CAMPUS_MANAGER could reset a teacher's password on ANY campus (B6-③).
    let campusFilter;
    try {
      campusFilter = buildCampusFilter(req.user);
    } catch {
      return sendForbidden(res, 'Campus access denied');
    }

    return profileSvc.resetManagedPassword(
      res,
      Teacher,
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
 * Permanently delete a teacher.
 *
 * Compatibility alias for `DELETE /api/danger-zone/teacher/:id` — the removal itself, the
 * cascade policy and the four confirmation controls all live in the harmonized hard-delete
 * service (CLAUDE.md §5.2). The impact preview that issues the required ticket is served by
 * `GET /api/danger-zone/teacher/:id/impact`.
 *
 * @route   DELETE /api/teachers/:id/permanent
 * @access  Private (ADMIN only)
 */
const deleteTeacherPermanently = async (req, res) => {
  try {
    const receipt = await hardDelete.service.execute({
      entityType: 'teacher',
      entityId:   req.params.id,
      req,
      confirmation: {
        ticket:             req.body?.ticket,
        confirmationPhrase: req.body?.confirmationPhrase,
        password:           req.body?.password,
        reason:             req.body?.reason,
      },
    });

    return sendSuccess(res, 200, 'Teacher deleted permanently', receipt);

  } catch (error) {
    return hardDelete.respondToError(res, error);
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
  restoreTeacher: entityController.restore,

  //Delete Teacher Permanently
  deleteTeacherPermanently
};