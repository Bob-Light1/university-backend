const express = require('express');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const {
  createSubject,
  getSubjects,
  getSubjectById,
  updateSubject,
  deleteSubject,
  restoreSubject
} = require('./controllers/subject.controller');


const {
  linkSubjectCourse,
  unlinkSubjectCourse,
} = require('./controllers/subject.course-link.controller');

const router = express.Router();

/**
 * Roles allowed to read: ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 * Roles allowed to modify: ADMIN, DIRECTOR, CAMPUS_MANAGER
 */

const staffRoles = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER'];
const adminRoles = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// Apply authentication to all routes
router.use(authenticate);

// --- CREATION AND GENERAL READ ROUTES ---

/**
 * @route   POST /api/subject
 * @desc    Create a new subject
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post("/", authorize(adminRoles), createSubject);

/**
 * @route   GET /api/subject
 * @desc    Retrieve all subjects
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
router.get("/", authorize(staffRoles), getSubjects);

// --- SPECIFIC LOOKUP ROUTES ---

/**
 * @route   GET /api/subject/:id
 * @desc    Retrieve a subject by its unique ID
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
router.get("/:id", authorize(staffRoles), getSubjectById);

// --- MODIFICATION AND DELETION ROUTES ---

/**
 * @route   PUT /api/subject/:id
 * @desc    Update a subject's information
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.put("/:id", authorize(adminRoles), updateSubject);

/**
 * @route   DELETE /api/subject/:id
 * @desc    Archive a subject (Soft Delete)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.delete("/:id", authorize(adminRoles), deleteSubject);

/**
 * @route   PATCH /api/subject/:id/restore
 * @desc    Restore an archived subject
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.patch("/:id/restore", authorize(adminRoles), restoreSubject);

// Link a Subject to a global Course
 router.patch('/:id/link-course', authorize(adminRoles), linkSubjectCourse);
 
 // Unlink a Subject from its Course reference
 router.delete('/:id/link-course', authorize(adminRoles), unlinkSubjectCourse);

module.exports = router;