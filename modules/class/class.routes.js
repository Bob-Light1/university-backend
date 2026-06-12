const express = require("express");
const { authenticate, authorize } = require('../../shared/middleware/auth');
const {
    createClass,
    getAllClass,
    getClassById,
    updateClass,
    getClassesByCampus,
    getClassesByTeacher,
    deleteClass,
    restoreClass
} = require('./controllers/class.controller');

const router = express.Router();

/**
 * Authorized roles for reading: CAMPUS_MANAGER, DIRECTOR, TEACHER
 * Authorized roles for modification: CAMPUS_MANAGER, DIRECTOR
 */

const staffRoles = ['CAMPUS_MANAGER', 'DIRECTOR', 'TEACHER', 'ADMIN'];
const adminRoles = ['CAMPUS_MANAGER', 'DIRECTOR', 'ADMIN'];

// Apply authentication to all routes
router.use(authenticate);

// --- GENERAL CREATION AND READING ROUTES ---

/**
 * @route   POST /api/class
 * @desc    Create a new class
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.post("/", authorize(adminRoles), createClass);

/**
 * @route   GET /api/class
 * @desc    Get all classes (with filters and pagination)
 * @access  CAMPUS_MANAGER, DIRECTOR, TEACHER
 */
router.get("/", authorize(staffRoles), getAllClass);

// --- SPECIFIC SEARCH ROUTES ---

/**
 * @route   GET /api/class/single/:id
 * @desc    Get a class by its unique ID
 * @access  CAMPUS_MANAGER, DIRECTOR, TEACHER
 */
router.get("/single/:id", authorize(staffRoles), getClassById);

/**
 * @route   GET /api/class/campus/:campusId
 * @desc    Get classes from a specific campus
 * @access  CAMPUS_MANAGER, DIRECTOR, TEACHER
 */
router.get("/campus/:campusId", authorize(staffRoles), getClassesByCampus);

/**
 * @route   GET /api/class/teacher/:teacherId
 * @desc    Get classes managed by a specific teacher
 * @access  CAMPUS_MANAGER, DIRECTOR, TEACHER
 */
router.get("/teacher/:teacherId", authorize(staffRoles), getClassesByTeacher);

// --- MODIFICATION AND DELETION ROUTES ---

/**
 * @route   PUT /api/class/:id
 * @desc    Update class information
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.put("/:id", authorize(adminRoles), updateClass);

/**
 * @route   DELETE /api/class/:id
 * @desc    Archive a class (Soft Delete)
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.delete("/:id", authorize(adminRoles), deleteClass);

/**
 * @route   PATCH /api/class/:id/restore
 * @desc    Restore an archived class
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.patch("/:id/restore", authorize(adminRoles), restoreClass);

module.exports = router;