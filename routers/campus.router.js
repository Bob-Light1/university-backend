const express = require('express');
const {
  getUploadSignature,
  createCampus,
  getAllCampus,
  loginCampus,
  updateCampus,
  getOneCampus,
  updateCampusPassword,
  deleteCampus,
  getCampusContext,
  getCampusClasses,
  getCampusTeachers,
  getCampusStudents,
  getCampusDashboardStats,
  getCampusStudentsStats,
  getCampusDepartments,
  getCampusMentors,
  getCampusPartners,
  getCampusParents,
  getCampusSubjects
} = require('../controllers/campus.controller');

const { authenticate, authorize } = require('../middleware/auth/auth');
const { loginLimiter, strictLimiter, apiLimiter } = require('../middleware/rate-limiter/rate-limiter');


const router = express.Router();

// ========================================
// PUBLIC ROUTES (No Authentication)
// ========================================

/**
 * @route   POST /api/campus/login
 * @desc    Campus manager login
 * @access  Public
 */
router.post("/login", loginLimiter, loginCampus);

/**
 * @route   GET /api/campus/all
 * @desc    Get all campuses (with pagination)
 * @access  Public
 * @note    Consider adding authentication if this contains sensitive data
 */
router.get("/all", apiLimiter, getAllCampus);

// ========================================
// PROTECTED ROUTES (Authentication Required)
// All routes below require authentication
// ========================================
router.use(authenticate);

// ========================================
// CAMPUS MANAGEMENT ROUTES
// ========================================

/**
 * @route   GET /api/campus/upload-signature
 * @desc    Return a signed Cloudinary upload params so the browser can upload
 *          the campus image directly to Cloudinary (no backend file transfer).
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/upload-signature",
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getUploadSignature
);

/**
 * @route   POST /api/campus/create
 * @desc    Create a new campus (campus_image is a Cloudinary URL sent by the browser)
 * @access  ADMIN, DIRECTOR only
 */
router.post(
  "/create",
  strictLimiter,
  authorize(['ADMIN', 'DIRECTOR']),
  createCampus
);

/**
 * @route   GET /api/campus/:id
 * @desc    Get single campus details
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER (own campus only)
 */
router.get(
  "/:id", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getOneCampus
);

/**
 * @route   PUT /api/campus/:id
 * @desc    Update campus information
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER (own campus only)
 */
router.put(
  "/:id",
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  updateCampus
);

/**
 * @route   PATCH /api/campus/:id/password
 * @desc    Update campus password
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER (own campus only)
 */
router.patch(
  "/:id/password", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  updateCampusPassword
);

/**
 * @route   DELETE /api/campus/:id
 * @desc    Archive/delete campus
 * @access  ADMIN, DIRECTOR only
 */
router.delete(
  "/:id", 
  authorize(['ADMIN', 'DIRECTOR']), 
  deleteCampus
);

// ========================================
// CAMPUS CONTEXT & RESOURCES ROUTES
// ========================================

/**
 * @route   GET /api/campus/:campusId/context
 * @desc    Get campus context with basic statistics
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/context", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusContext
);

/**
 * @route   GET /api/campus/:campusId/dashboard
 * @desc    Get campus dashboard statistics
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/dashboard", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusDashboardStats
);

// ========================================
// CAMPUS RESOURCES ROUTES
// ========================================

/**
 * @route   GET /api/campus/:campusId/students
 * @desc    Get all students in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/students", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusStudents
);

/**
 * @route   GET /api/campus/:campusId/teachers
 * @desc    Get all teachers in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/teachers", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusTeachers
);

/**
 * @route   GET /api/campus/:campusId/parents
 * @desc    Get all parents in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/parents", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusParents
);

/**
 * @route   GET /api/campus/:campusId/mentors
 * @desc    Get all mentors in a specific campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/mentors", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusMentors
);

/**
 * @route   GET /api/campus/:campusId/partners
 * @desc    Get all partners from a specific campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/partners", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusPartners
);

/**
 * @route   GET /api/campus/:campusId/classes
 * @desc    Get all classes in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/classes", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusClasses
);

/**
 * @route   GET /api/campus/:campusId/subjects
 * @desc    Get all subjects in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/subjects", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  getCampusSubjects
);

/**
 * @route   GET /api/campus/:campusId/departments
 * @desc    Get all departments in specific campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.get(
  "/:campusId/departments",
  getCampusDepartments
);

/**
 * @route   GET /api/campus/:campusId/students/stats
 * @desc    Get students statistics for all the campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Administration should be able to see directly all important statistics
 */
router.get(
  "/:campusId/students/stats", 
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  getCampusStudentsStats
);

/**
 * @route   GET /api/campus/:id/staff
 * @desc    Get all staff in a campus
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
/** router.get(
  *  "/:id/staff", 
  *  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']), 
  *  getCampusStaff
  *)
  */

module.exports = router;