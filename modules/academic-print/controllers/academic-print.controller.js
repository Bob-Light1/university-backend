'use strict';

/**
 * @file academic-print.controller.js
 * @description Controller for the Academic Print Module.
 *
 * Supported document types:
 *   STUDENT_CARD  — CR80 ID card (85.6×54mm)
 *   TRANSCRIPT    — Semester bulletin A4
 *   ENROLLMENT    — Enrollment certificate A4
 *   TIMETABLE     — Class weekly timetable A4 landscape
 *   STUDENT_LIST  — Class roster A4
 *   TEACHER_LIST  — Class teaching staff A4
 *
 * Endpoints:
 *   POST /api/print/preview          → stream PDF preview (single, not saved)
 *   GET  /api/print/jobs             → list recent batch jobs for campus
 *   POST /api/print/batch            → enqueue batch job, returns { jobId }
 *   GET  /api/print/batch/:jobId     → job progress / results
 *   GET  /api/print/batch/:jobId/download/:fileName → stream a result PDF
 *
 * Batch jobs are persisted in MongoDB (PrintJob) and processed by the queue
 * worker (print-job.processor.js) — status & result PDFs are reachable from any
 * worker in a multi-process deployment. Result PDFs live on disk under
 * uploads/print/{campusId}/ for 30 days (TTL aligned with the job metadata).
 */

const mongoose = require('mongoose');

const { asyncHandler, sendSuccess, sendError, sendPaginated } = require('../../../shared/utils/response-helpers');
const { generateAcademicPdf, readPrintPdf } = require('../academic-pdf.service');

const repo = require('../print-job.repository');
const {
  loadStudent,
  loadStudentsByClass,
  loadClassSessions,
  loadClassTeachers,
  kick,
} = require('../print-job.processor');

const studentService = require('../../student').service;          // student module facade (§3)
const { getClassNameInCampus } = require('../../class').service;  // class module facade (§3)
const resultService = require('../../result').service;            // result module facade (§3)
const { getPreferredLanguage } = require('../../settings').service;

const VALID_TYPES = ['STUDENT_CARD', 'TRANSCRIPT', 'ENROLLMENT', 'TIMETABLE', 'STUDENT_LIST', 'TEACHER_LIST'];

// Types that produce one PDF per class (not per student)
const CLASS_LEVEL_TYPES = ['TIMETABLE', 'STUDENT_LIST', 'TEACHER_LIST'];

/**
 * Resolve campusId from the request.
 * - CAMPUS_MANAGER : always uses JWT campusId (campus isolation enforced server-side)
 * - ADMIN/DIRECTOR : may supply campusId in body or query (required for scoped operations)
 */
const resolveCampusId = (req) => {
  const { role, campusId: jwtCampusId } = req.user;
  if (['ADMIN', 'DIRECTOR'].includes(role)) {
    return req.body?.campusId || req.query?.campusId || null;
  }
  return jwtCampusId || null;
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/print/preview
 * Stream a PDF preview buffer (not saved). Single student or class target.
 *
 * Body: { type, studentId?, classId?, params: { academicYear, semester, weekStart } }
 */
const previewPdf = asyncHandler(async (req, res) => {
  const { type, studentId, classId, params = {} } = req.body;
  const campusId = resolveCampusId(req);

  if (!campusId) return sendError(res, 400, 'campusId is required for ADMIN/DIRECTOR — pass it in the request body.');
  if (!VALID_TYPES.includes(type)) return sendError(res, 400, `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);

  const locale = await getPreferredLanguage(req.user.id).catch(() => 'en');

  let buffer;

  if (type === 'STUDENT_CARD' || type === 'ENROLLMENT') {
    if (!studentId) return sendError(res, 400, 'studentId is required');
    const student = await loadStudent(studentId, campusId);
    buffer = await generateAcademicPdf({ type, data: { student }, campusId, params, locale });

  } else if (type === 'TRANSCRIPT') {
    if (!studentId) return sendError(res, 400, 'studentId is required');
    if (!params.academicYear || !params.semester) return sendError(res, 400, 'params.academicYear and params.semester are required');
    const student    = await loadStudent(studentId, campusId);
    const transcript = await resultService.getTranscriptForPrint({
      studentId, campusId,
      academicYear: params.academicYear, semester: params.semester,
    });
    if (!transcript) return sendError(res, 404, 'No transcript found for this student / academic year / semester');
    buffer = await generateAcademicPdf({ type: 'TRANSCRIPT', data: { student, transcript }, campusId, params, locale });

  } else if (type === 'TIMETABLE') {
    if (!classId) return sendError(res, 400, 'classId is required for TIMETABLE');
    const cls      = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const sessions = await loadClassSessions(classId, campusId, params);
    buffer = await generateAcademicPdf({ type: 'TIMETABLE', data: { sessions, cls }, campusId, params, locale });

  } else if (type === 'STUDENT_LIST') {
    if (!classId) return sendError(res, 400, 'classId is required for STUDENT_LIST');
    const cls = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const students = await studentService.listClassStudentsForList(classId, campusId);
    buffer = await generateAcademicPdf({ type: 'STUDENT_LIST', data: { students, cls }, campusId, params, locale });

  } else if (type === 'TEACHER_LIST') {
    if (!classId) return sendError(res, 400, 'classId is required for TEACHER_LIST');
    const cls = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const teachers = await loadClassTeachers(classId, campusId);
    buffer = await generateAcademicPdf({ type: 'TEACHER_LIST', data: { teachers, cls }, campusId, params, locale });
  }

  if (!buffer) return sendError(res, 500, 'Failed to generate PDF');

  res.set({
    'Content-Type':        'application/pdf',
    'Content-Length':      buffer.length,
    'Content-Disposition': `inline; filename="preview_${type.toLowerCase()}.pdf"`,
    'Cache-Control':       'no-store',
  });
  return res.end(buffer);
});

/**
 * GET /api/print/jobs
 * List batch jobs for this campus (most recent first).
 */
const listJobs = asyncHandler(async (req, res) => {
  const campusId = resolveCampusId(req);
  const { page = 1, limit = 20 } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

  const { data, total } = await repo.paginateForCampus({
    campusId,
    skip:  (pageNum - 1) * limitNum,
    limit: limitNum,
  });

  return sendPaginated(res, 200, 'Print jobs fetched.', data.map((j) => ({
    id:          String(j._id),
    type:        j.type,
    status:      j.status,
    progress:    j.progress,
    params:      j.params,
    startedAt:   j.startedAt,
    completedAt: j.completedAt,
    createdAt:   j.createdAt,
  })), { total, page: pageNum, limit: limitNum });
});

/**
 * POST /api/print/batch
 * Enqueue a batch print job for a whole class or a list of student IDs.
 *
 * Body: {
 *   type,
 *   classId?,      // all students in the class (STUDENT_CARD, TRANSCRIPT, ENROLLMENT)
 *                  // or the class itself (TIMETABLE, STUDENT_LIST, TEACHER_LIST)
 *   studentIds?,   // explicit list (overrides classId for student types)
 *   params: { academicYear, semester, weekStart, cardNumber, cardValidUntil }
 * }
 */
const startBatch = asyncHandler(async (req, res) => {
  const { type, classId, studentIds, params = {} } = req.body;
  const campusId    = resolveCampusId(req);
  const requestedBy = req.user.id;
  const locale      = await getPreferredLanguage(req.user.id).catch(() => 'en');

  if (!campusId) return sendError(res, 400, 'campusId is required for ADMIN/DIRECTOR — pass it in the request body.');
  if (!VALID_TYPES.includes(type)) return sendError(res, 400, `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);

  let targets = [];

  if (CLASS_LEVEL_TYPES.includes(type)) {
    // Class-level batch: one PDF per class (TIMETABLE, STUDENT_LIST, TEACHER_LIST)
    if (!classId) return sendError(res, 400, `classId is required for ${type} batch`);
    const cls = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    targets = [{ id: String(classId), name: cls.className }];

  } else {
    // Student-type batches
    if (studentIds && Array.isArray(studentIds) && studentIds.length > 0) {
      if (studentIds.length > 500) return sendError(res, 400, 'Batch size exceeds limit of 500 students');
      const students = await studentService.getStudentNamesByIds(studentIds, campusId);
      targets = students.map((s) => ({ id: String(s._id), name: `${s.firstName} ${s.lastName}` }));
    } else if (classId) {
      const students = await loadStudentsByClass(classId, campusId);
      targets = students.map((s) => ({ id: String(s._id), name: `${s.firstName} ${s.lastName}` }));
    } else {
      return sendError(res, 400, 'Provide either classId or studentIds');
    }
    if (targets.length === 0) return sendError(res, 404, 'No eligible students found');
    if (targets.length > 500) return sendError(res, 400, 'Batch size exceeds limit of 500 students');
  }

  const job = await repo.create({
    campusId:    String(campusId),
    type,
    status:      'PENDING',
    params:      { ...params, locale },
    targets,
    results:     [],
    progress:    { total: targets.length, done: 0, failed: 0 },
    requestedBy,
  });

  // Best-effort inline processing; the sweep cron is the safety net (see processor).
  kick(String(job._id));

  return sendSuccess(res, 202, 'Batch job started.', { jobId: String(job._id), total: targets.length });
});

/**
 * GET /api/print/batch/:jobId
 * Get status and results of a batch job.
 */
const getBatchJobStatus = asyncHandler(async (req, res) => {
  const { jobId }  = req.params;
  const campusId   = resolveCampusId(req);

  if (!mongoose.isValidObjectId(jobId)) return sendError(res, 404, 'Job not found');

  const job = await repo.findByIdLean(jobId);
  if (!job || (campusId && String(job.campusId) !== String(campusId))) {
    return sendError(res, 404, 'Job not found');
  }

  return sendSuccess(res, 200, 'Job status fetched.', {
    id:          String(job._id),
    type:        job.type,
    status:      job.status,
    progress:    job.progress,
    params:      job.params,
    results:     job.results,
    startedAt:   job.startedAt,
    completedAt: job.completedAt,
    createdAt:   job.createdAt,
  });
});

/**
 * GET /api/print/batch/:jobId/download/:fileName
 * Stream a result PDF from a completed batch job.
 */
const downloadBatchResult = asyncHandler(async (req, res) => {
  const { jobId, fileName } = req.params;
  const campusId = resolveCampusId(req);

  if (!mongoose.isValidObjectId(jobId)) return sendError(res, 404, 'Job not found');

  const job = await repo.findByIdLean(jobId);
  if (!job || (campusId && String(job.campusId) !== String(campusId))) return sendError(res, 404, 'Job not found');

  // Verify this fileName belongs to this job (security: prevent path traversal)
  const isOwned = (job.results || []).some((r) => r.fileName === fileName);
  if (!isOwned) return sendError(res, 403, 'File does not belong to this job');

  // Sanitize fileName: only allow safe characters
  if (!/^[\w.-]+\.pdf$/.test(fileName)) return sendError(res, 400, 'Invalid file name');

  // Read from the campus the file was actually saved under (job.campusId), not the
  // resolved request campus — ADMIN/DIRECTOR may not pass a campusId at all.
  const buffer = await readPrintPdf(job.campusId, fileName);

  res.set({
    'Content-Type':        'application/pdf',
    'Content-Length':      buffer.length,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control':       'no-store', // academic records — do not cache to disk
  });
  return res.end(buffer);
});

module.exports = {
  previewPdf,
  listJobs,
  startBatch,
  getBatchJobStatus,
  downloadBatchResult,
};
