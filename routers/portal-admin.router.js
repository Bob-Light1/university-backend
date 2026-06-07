'use strict';

/**
 * @file portal-admin.router.js
 * @description Authenticated admin CRUD for Phase 2 portal content.
 *
 * Base path : /api/portal-admin  (mounted in server.js, behind JWT auth)
 *
 * Manages the content surfaced by the public portal endpoints:
 *   Testimonial · FaqEntry · CoursePreview · CompetitionPrize
 *
 * Access : ADMIN / DIRECTOR (all campuses) and CAMPUS_MANAGER (own campus only).
 */

const express = require('express');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth/auth');

const { makeContentController } = require('../controllers/portal-admin/portal-admin.factory');
const competitionCtrl = require('../controllers/portal-admin/competition.admin.controller');

const Testimonial   = require('../models/partner-models/testimonial.model');
const FaqEntry       = require('../models/partner-models/faq.entry.model');
const CoursePreview  = require('../models/partner-models/course.preview.model');

const MGMT_ROLES = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// All routes require authentication + a management role.
router.use(authenticate, authorize(MGMT_ROLES));

// ─── Generic content resources (testimonials, faq, course previews) ────────────
const testimonialsCtrl = makeContentController(Testimonial, {
  label:      'Testimonial',
  allowed:    ['firstName', 'city', 'graduationYear', 'program', 'quote', 'photoUrl', 'employer', 'isPublished', 'order'],
  searchKeys: ['firstName', 'employer', 'program'],
});

const faqCtrl = makeContentController(FaqEntry, {
  label:      'FAQ',
  allowed:    ['question', 'answer', 'category', 'order', 'isPublished'],
  searchKeys: ['question.fr', 'question.en'],
});

const coursesCtrl = makeContentController(CoursePreview, {
  label:      'Course preview',
  allowed:    ['program', 'title', 'content', 'videoUrl', 'order', 'isPublished'],
  searchKeys: ['program', 'title.fr'],
});

/** Wires the standard 6-route CRUD surface for a generic content controller. */
function mountContent(path, ctrl) {
  router.get(path, ctrl.list);
  router.post(path, ctrl.create);
  router.get(`${path}/:id`, ctrl.getOne);
  router.put(`${path}/:id`, ctrl.update);
  router.patch(`${path}/:id/publish`, ctrl.togglePublish);
  router.delete(`${path}/:id`, ctrl.remove);
}

mountContent('/testimonials', testimonialsCtrl);
mountContent('/faq', faqCtrl);
mountContent('/course-previews', coursesCtrl);

// ─── Competition (prize schedule + cron-driven winners) ────────────────────────
router.get('/competition', competitionCtrl.list);
router.post('/competition', competitionCtrl.create);
router.get('/competition/:id', competitionCtrl.getOne);
router.put('/competition/:id', competitionCtrl.update);
router.patch('/competition/:id/toggle-active', competitionCtrl.toggleActive);
router.post('/competition/:id/close', competitionCtrl.closeNow);
router.delete('/competition/:id', competitionCtrl.remove);

module.exports = router;
