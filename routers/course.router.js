'use strict';

/**
 * @file course.router.js
 * @description Express router for the global course catalog.
 *
 *  Registration in server.js:
 *    const courseRouter = require('./routers/course.router');
 *    app.use('/api/courses', courseRouter);
 *
 *  Subject linking routes are registered on a SEPARATE subject-extended router.
 *  Add the following two lines to subject.router.js to activate them:
 *    router.patch('/:id/link-course',   authorize(managerRoles), linkSubjectCourse);
 *    router.delete('/:id/link-course',  authorize(managerRoles), unlinkSubjectCourse);
 *
 *  Route ordering:
 *  ─────────────────────────────────────────────────────────────────
 *  Named/specific routes (e.g. /code/:courseCode, /:id/versions)
 *  are declared BEFORE the generic /:id route to avoid Express
 *  matching conflicts.
 *
 *  Role matrix (see design doc §6.1):
 *  ─────────────────────────────────
 *  allRoles     = all authenticated users
 *  globalRoles  = ADMIN, DIRECTOR
 *  managerRoles = ADMIN, DIRECTOR, CAMPUS_MANAGER
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');
const { apiLimiter }              = require('../middleware/rate-limiter/rate-limiter');

// ─── CONTROLLER IMPORTS ───────────────────────────────────────────────────────

const {
  createCourse,
  listCourses,
  getCourseById,
  getCourseByCode,
  getCourseVersions,
  updateCourse,
  softDeleteCourse,
  restoreCourse,
} = require('../controllers/course-controllers/course.crud.controller');

const {
  submitForReview,
  approveCourse,
  rejectCourse,
  createNewVersion,
} = require('../controllers/course-controllers/course.workflow.controller');

const {
  addResource,
  removeResource,
} = require('../controllers/course-controllers/course.resources.controller');

// ─── ROLE GROUPS ──────────────────────────────────────────────────────────────

const allRoles     = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'TEACHER', 'STUDENT'];
const globalRoles  = ['ADMIN', 'DIRECTOR'];
const managerRoles = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────

// All routes require authentication
router.use(authenticate);

// Apply per-route rate limiting on read endpoints
router.use(apiLimiter);

// ─── READ ROUTES — all authenticated roles ────────────────────────────────────

/**
 * @route  GET /api/courses
 * @desc   Paginated list with filters and role-based visibility
 * @access All authenticated roles
 */
router.get('/', authorize(allRoles), listCourses);

/**
 * @route  GET /api/courses/code/:courseCode
 * @desc   Retrieve the latest version of a course by code
 * @access All authenticated roles
 * @note   Must be declared BEFORE /:id to avoid Express conflict
 */
router.get('/code/:courseCode', authorize(allRoles), getCourseByCode);

/**
 * @route  GET /api/courses/:id/versions
 * @desc   Full version history of a course
 * @access ADMIN, DIRECTOR only
 * @note   Must be declared BEFORE /:id
 */
router.get('/:id/versions', authorize(globalRoles), getCourseVersions);

/**
 * @route  GET /api/courses/:id
 * @desc   Full course detail (syllabus, resources, history)
 * @access All authenticated roles (APPROVED only for non-global)
 */
router.get('/:id', authorize(allRoles), getCourseById);

// ─── WRITE ROUTES — ADMIN / DIRECTOR ─────────────────────────────────────────

/**
 * @route  POST /api/courses
 * @desc   Create a new course (DRAFT, v1)
 * @access ADMIN, DIRECTOR
 */
router.post('/', authorize(globalRoles), createCourse);

/**
 * @route  PUT /api/courses/:id
 * @desc   Update a DRAFT/REJECTED course (guard: 409 on APPROVED pedagogical fields)
 * @access ADMIN, DIRECTOR
 */
router.put('/:id', authorize(globalRoles), updateCourse);

/**
 * @route  DELETE /api/courses/:id
 * @desc   Soft-delete (guard: blocked if active Subject references exist)
 * @access ADMIN only
 */
router.delete('/:id', authorize(['ADMIN']), softDeleteCourse);

/**
 * @route  PATCH /api/courses/:id/restore
 * @desc   Restore a soft-deleted course
 * @access ADMIN only
 */
router.patch('/:id/restore', authorize(['ADMIN']), restoreCourse);

// ─── WORKFLOW ROUTES ──────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/courses/:id/submit
 * @desc   DRAFT | REJECTED → PENDING_REVIEW
 * @access ADMIN, DIRECTOR
 */
router.patch('/:id/submit', authorize(globalRoles), submitForReview);

/**
 * @route  PATCH /api/courses/:id/approve
 * @desc   PENDING_REVIEW → APPROVED
 * @access ADMIN, DIRECTOR
 */
router.patch('/:id/approve', authorize(globalRoles), approveCourse);

/**
 * @route  PATCH /api/courses/:id/reject
 * @desc   PENDING_REVIEW → REJECTED (note ≥ 10 chars required)
 * @access ADMIN, DIRECTOR
 */
router.patch('/:id/reject', authorize(globalRoles), rejectCourse);

/**
 * @route  POST /api/courses/:id/new-version
 * @desc   Clone APPROVED → new DRAFT (version + 1, atomic transaction)
 * @access ADMIN, DIRECTOR
 * @body   {boolean} [copyResources=true] — Pass false to create the new draft without
 *         the parent's resources. Useful when the resource set is large or outdated.
 *         Defaults to true for backward compatibility.
 */
router.post('/:id/new-version', authorize(globalRoles), createNewVersion);

// ─── RESOURCE ROUTES ──────────────────────────────────────────────────────────

/**
 * @route  POST /api/courses/:id/resources
 * @desc   Add a learning resource (CAMPUS_MANAGER can contribute)
 * @access ADMIN, DIRECTOR, CAMPUS_MANAGER
 */
router.post('/:id/resources', authorize(managerRoles), addResource);

/**
 * @route  DELETE /api/courses/:id/resources/:resourceId
 * @desc   Remove a learning resource
 * @access ADMIN, DIRECTOR
 */
router.delete('/:id/resources/:resourceId', authorize(globalRoles), removeResource);

module.exports = router;