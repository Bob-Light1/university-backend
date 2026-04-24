const express = require('express');
const router = express.Router();

const studentController          = require('../controllers/student-controllers/student.controller');
const studentDashboardController = require('../controllers/student-controllers/student.dashboard.controller');
const { authenticate, authorize, isOwnerOrRole } = require('../middleware/auth/auth');
const { loginLimiter, apiLimiter } = require('../middleware/rate-limiter/rate-limiter');
const { 
  uploadProfileImage,
  uploadDocument,
  handleMulterError 
} = require('../middleware/upload/upload');

// ========================================
// PUBLIC ROUTES (No Authentication)
// ========================================

/**
 * @route   POST /api/students/login
 * @desc    Student login
 * @access  Public
 */
router.post('/login', loginLimiter, studentController.loginStudent);

// ========================================
// PROTECTED ROUTES (Authentication Required)
// All routes below require authentication
// ========================================
router.use(authenticate);

// ========================================
// STUDENT CREATION & LISTING
// ========================================

/**
 * @route   POST /api/students
 * @desc    Create a new student
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Campus is automatically assigned based on user role
 */
router.post(
  '/',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadProfileImage,
  handleMulterError,
  studentController.createStudent
);

/**
 * @route   GET /api/students
 * @desc    Get all students with filters and pagination
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 * @query   page, limit, search, status, classId, campusId (ADMIN only)
 * @note    Campus isolation enforced - managers see only their campus
 */
router.get(
  '/',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  apiLimiter,
  studentController.getAllStudents
);

// ========================================
// STUDENT SELF-SERVICE
// ========================================

/**
 * @route   GET /api/students/me/dashboard
 * @desc    Student's personal dashboard (KPIs, today's schedule, results, exams)
 * @access  STUDENT (own)
 * @note    Must be declared BEFORE /:id to avoid Express matching "me" as an ID
 */
router.get(
  '/me/dashboard',
  authorize(['STUDENT']),
  studentDashboardController.getDashboard
);

// ========================================
// IMPORT/EXPORT OPERATIONS
// ========================================

/**
 * @route   GET /api/students/export/csv
 * @desc    Export student information to CSV
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  '/export/csv',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.exportToCSV
);


/**
 * @route   GET /api/students/export/excel
 * @desc    Export student information to Excel
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  '/export/excel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.exportToExcel
);

/**
 * @route   GET /api/students/export
 * @desc    Alias for backward compatibility
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Must be declared BEFORE /:id to avoid Express matching "export" as an ID
 */
router.get(
  '/export',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.exportToCSV
);

/**
 * @route   POST /api/students/import
 * @desc    Import student information from CSV/Excel
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload CSV/Excel file
  handleMulterError,
  studentController.importFromFile
);

/**
 * @route   POST /api/students/template/csv
 * @desc    Import CSV template
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import/template/csv',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload CSV file
  handleMulterError,
  studentController.getImportTemplateCSV
);

/**
 * @route   POST /api/students/template/excel
 * @desc    Import Excel template
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import/template/excel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload Excel file
  handleMulterError,
  studentController.getImportTemplateExcel
);

// ========================================
// INDIVIDUAL STUDENT ROUTES
// ========================================

/**
 * @route   GET /api/students/:id
 * @desc    Get a single student by ID
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER, STUDENT (own profile)
 * @note    Students can only view their own profile
 *          Staff can view students from their campus
 */
router.get(
  '/:id',
  isOwnerOrRole('id', ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER']),
  studentController.getOneStudent
);

/**
 * @route   PUT /api/students/:id
 * @desc    Update student information
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Cannot change campus or password via this route
 */
router.put(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadProfileImage,    //Optional profile image update
  handleMulterError,
  studentController.updateStudent
);

/**
 * @route   PATCH /api/students/:id/password
 * @desc    Update student password
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, STUDENT (own password)
 * @note    Students must provide current password
 *          Admins can change any password without current password
 */
router.patch(
  '/:id/password',
  isOwnerOrRole('id', ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.updateStudentPassword
);

// ========================================
// STUDENT ARCHIVE & DELETION
// ========================================

/**
 * @route   DELETE /api/students/:id
 * @desc    Archive student (soft delete)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Sets status to 'archived', doesn't delete from database
 */
router.delete(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.archiveStudent
);

/**
 * @route   PATCH /api/students/:id/restore
 * @desc    Restore archived student
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Sets status back to 'active'
 */
router.patch(
  '/:id/restore',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.restoreStudent
);

/**
 * @route   DELETE /api/students/:id/permanent
 * @desc    Permanently delete student
 * @access  ADMIN only
 * @note    ⚠️ DESTRUCTIVE - Cannot be undone, also deletes profile image
 */
router.delete(
  '/:id/permanent',
  authorize(['ADMIN']),
  studentController.deleteStudentPermanently
);

// ========================================
// BULK OPERATIONS
// ========================================

/**
 * @route   POST /api/students/bulk/change-class
 * @desc    Change class for multiple students
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Allow user to select many students and put them in a new class
 */
router.post(
  '/bulk/change-class',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.bulkChangeClass
);

/**
 * @route   POST /api/students/bulk/email
 * @desc    Send email to many students
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Allow user to send many emails to many students at once
 */
router.post(
  '/bulk/email',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.bulkSendEmail
);

/**
 * @route   POST /api/students/bulk/archive
 * @desc    Archive many students at once
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Allow user to select many students and archive them
 */
router.post(
  '/bulk/archive',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  studentController.bulkArchive
);

module.exports = router;