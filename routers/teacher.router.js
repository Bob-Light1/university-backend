const express = require('express');
const router = express.Router();

const teacherController          = require('../controllers/teacher-controllers/teacher.controller');
const teacherDashboardController = require('../controllers/teacher-controllers/teacher.dashboard.controller');
const { authenticate, authorize, isOwnerOrRole } = require('../middleware/auth/auth');
const { loginLimiter, apiLimiter } = require('../middleware/rate-limiter/rate-limiter');
const { 
  uploadProfileImage,
  uploadDocument,
  handleMulterError 
} = require('../middleware/upload/upload');

// Role configurations
const ADMIN_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ========================================
// PUBLIC ROUTES (No Authentication)
// ========================================

/**
 * @route   POST /api/teachers/login
 * @desc    Teacher login
 * @access  Public
 */
router.post('/login', loginLimiter, teacherController.loginTeacher);

// ========================================
// PROTECTED ROUTES (Authentication Required)
// ========================================
router.use(authenticate);

// ========================================
// TEACHER CREATION & LISTING
// ========================================

/**
 * @route   POST /api/teachers
 * @desc    Create a new teacher
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Campus is automatically assigned based on user role
 *          Classes must belong to the same campus
 ***/
router.post(
  '/',
  authorize(ADMIN_ROLES),
  uploadProfileImage,
  handleMulterError,    
  teacherController.createTeacher
);

/**
 * @route   GET /api/teachers
 * @desc    Get all teachers with filters and pagination
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @query   page, limit, search, status, gender, employmentType, campusId (ADMIN only)
 * @note    CRITICAL FIX: Campus isolation enforced -> anagers can ONLY see teachers from their campus
 */
router.get(
  '/',
  authorize(ADMIN_ROLES),
  apiLimiter,
  teacherController.getAllTeachers
);

// ========================================
// TEACHER SELF-SERVICE
// ========================================

/**
 * @route   GET /api/teachers/me/dashboard
 * @desc    Teacher's personal dashboard (KPIs, today's sessions, pending roll-calls)
 * @access  TEACHER (own)
 * @note    Must be declared BEFORE /:id to avoid Express matching "me" as an ID
 */
router.get(
  '/me/dashboard',
  authorize(['TEACHER']),
  teacherDashboardController.getDashboard
);

// ========================================
// IMPORT/EXPORT OPERATIONS
// ========================================

/**
 * @route   GET /api/teachers/export/csv
 * @desc    Export teacher's information to CSV
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  '/export/csv',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  teacherController.exportToCSV
);


/**
 * @route   GET /api/teachers/export/excel
 * @desc    Export teacher's information to Excel
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  '/export/excel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  teacherController.exportToExcel
);

/**
 * @route   GET /api/teachers/export
 * @desc    Alias for backward compatibility
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Must be declared BEFORE /:id to avoid Express matching "export" as an ID
 */
router.get(
  '/export',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  teacherController.exportToCSV
);

/**
 * @route   POST /api/teachers/import
 * @desc    Import teacher's information from CSV/Excel
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload CSV/Excel file
  handleMulterError,
  teacherController.importFromFile
);

/**
 * @route   POST /api/teachers/import/template/csv
 * @desc    Import CSV template
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import/template/csv',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload CSV file
  handleMulterError,
  teacherController.getImportTemplateCSV
);

/**
 * @route   POST /api/teachers/import/template/excel
 * @desc    Import Excel template
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post(
  '/import/template/excel',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  uploadDocument,        // Upload Excel file
  handleMulterError,
  teacherController.getImportTemplateExcel
);

// ========================================
// INDIVIDUAL TEACHER ROUTES
// ========================================

/**
 * @route   GET /api/teachers/:id
 * @desc    Get a single teacher by ID
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER (own profile)
 * @note    Teachers can view their own profile
 *          Staff can view teachers from their campus
 */
router.get(
  '/:id',
  isOwnerOrRole('id', ADMIN_ROLES),
  teacherController.getOneTeacher
);

/**
 * @route   PUT /api/teachers/:id
 * @desc    Update teacher information
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Cannot change campus, password, or salary via this route
 *          Classes must belong to the same campus
 */

router.put(
  '/:id',
  authorize(ADMIN_ROLES),
  uploadProfileImage,  
  handleMulterError,
  teacherController.updateTeacher
);

/**
 * @route   PATCH /api/teachers/:id/password
 * @desc    Update teacher password
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER (own password)
 * @note    Teachers must provide current password
 *          Admins can change any password without current password
 */
router.patch(
  '/:id/password',
  isOwnerOrRole('id', ADMIN_ROLES),
  teacherController.updateTeacherPassword
);

// ========================================
// TEACHER ARCHIVE & DELETION
// ========================================

/**
 * @route   DELETE /api/teachers/:id
 * @desc    Archive teacher (soft delete)
 * @access  ADMIN, DIRECTOR
 * @note    Sets status to 'archived', doesn't delete from database
 */
router.delete(
  '/:id',
  authorize(['ADMIN', 'DIRECTOR']),
  teacherController.archiveTeacher
);

/**
 * @route   PATCH /api/teachers/:id/restore
 * @desc    Restore archived teacher
 * @access  ADMIN, DIRECTOR
 * @note    Sets status back to 'active'
 */
router.patch(
  '/:id/restore',
  authorize(['ADMIN', 'DIRECTOR']),
  teacherController.restoreTeacher
);

/**
 * @route   DELETE /api/teachers/:id/permanent
 * @desc    Permanently delete teacher
 * @access  ADMIN only
 * @note    ⚠️ DESTRUCTIVE - Cannot be undone, also deletes teacher image
 */
router.delete(
  '/:id/permanent',
  authorize(['ADMIN']),
  teacherController.deleteTeacherPermanently
);

// ========================================
// BULK OPERATIONS
// ========================================

/**
 * @route   POST /api/teachers/bulk/change-department
 * @desc    Change department for multiple teachers
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
/*router.post(
  '/bulk/change-department',
  authorize(ADMIN_ROLES),
  teacherController.bulkChangeDepartment
);*/

/**
 * @route   POST /api/teachers/bulk/email
 * @desc    Send email to many teachers
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Allow user to send many emails to many teachers at once
 */
router.post(
  '/bulk/email',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  teacherController.bulkSendEmail
);

/**
 * @route   POST /api/teachers/bulk/archive
 * @desc    Archive many teachers at once
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Allow user to select many teachers and archive them
 */
router.post(
  '/bulk/archive',
  authorize(['ADMIN', 'DIRECTOR']),
  teacherController.bulkArchive
);


module.exports = router;