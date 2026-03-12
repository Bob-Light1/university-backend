const express = require('express');
const { authenticate, authorize } = require('../middleware/auth/auth');
const {
  createSubject,
  getSubjects,
  getSubjectById,
  updateSubject,
  deleteSubject,
  restoreSubject
} = require('../controllers/subject.controller');


const {
  linkSubjectCourse, 
  unlinkSubjectCourse, 
} = require('../controllers/course-controllers/course.resources.controller');

const router = express.Router();

/**
 * Roles autorisés pour la lecture : ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 * Roles autorisés pour la modification : ADMIN, DIRECTOR, CAMPUS_MANAGER
 */

const staffRoles = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER'];
const adminRoles = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// Apply authentication to all routes
router.use(authenticate);

// --- ROUTES DE CRÉATION ET LECTURE GÉNÉRALE ---

/**
 * @route   POST /api/subject
 * @desc    Créer une nouvelle matière
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post("/", authorize(adminRoles), createSubject);

/**
 * @route   GET /api/subject
 * @desc    Récupérer toutes les matières
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
router.get("/", authorize(staffRoles), getSubjects);

// --- ROUTES DE RECHERCHE SPÉCIFIQUE ---

/**
 * @route   GET /api/subject/:id
 * @desc    Récupérer une matière par son ID unique
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER
 */
router.get("/:id", authorize(staffRoles), getSubjectById);

// --- ROUTES DE MODIFICATION ET SUPPRESSION ---

/**
 * @route   PUT /api/subject/:id
 * @desc    Mettre à jour les informations d'une matière
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.put("/:id", authorize(adminRoles), updateSubject);

/**
 * @route   DELETE /api/subject/:id
 * @desc    Archiver une matière (Soft Delete)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.delete("/:id", authorize(adminRoles), deleteSubject);

/**
 * @route   PATCH /api/subject/:id/restore
 * @desc    Restaurer une matière archivée
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.patch("/:id/restore", authorize(adminRoles), restoreSubject);

// Link a Subject to a global Course
 router.patch('/:id/link-course', authorize(adminRoles), linkSubjectCourse);
 
 // Unlink a Subject from its Course reference
 router.delete('/:id/link-course', authorize(adminRoles), unlinkSubjectCourse);

module.exports = router;