'use strict';

/**
 * @file academic_print.controller.js
 * @description Controller for the Academic Print Module.
 *
 * Supported document types:
 *   STUDENT_CARD  — CR80 ID card (85.6×54mm)
 *   TRANSCRIPT    — Semester bulletin A4
 *   ENROLLMENT    — Enrollment certificate A4
 *   TIMETABLE     — Class weekly timetable A4 landscape
 *
 * Endpoints:
 *   POST /api/print/preview          → stream PDF preview (single, not saved)
 *   GET  /api/print/jobs             → list recent batch jobs for campus
 *   POST /api/print/batch            → enqueue batch job, returns { jobId }
 *   GET  /api/print/batch/:jobId     → job progress / results
 *   GET  /api/print/batch/:jobId/download/:fileName → stream a result PDF
 *
 * Batch jobs are tracked in-process (Map) — sufficient for single-process deployments.
 * Result PDFs are persisted on disk under uploads/print/{campusId}/ for 30 days.
 */

const crypto = require('crypto');

const { asyncHandler, sendSuccess, sendError, sendPaginated } = require('../utils/responseHelpers');
const { generateAcademicPdf, savePrintPdf, readPrintPdf }    = require('../services/academic_pdf.service');

const Student         = require('../models/student-models/student.model');
const Class           = require('../models/class.model');
const { FinalTranscript } = require('../models/finalTranscript.model');

// ── In-process job store ──────────────────────────────────────────────────────
// Structure: Map<jobId, JobRecord>
// JobRecord: { id, campusId, type, status, params, targets, results, progress, startedAt, completedAt, requestedBy }

const JOBS = new Map();
const JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days before job metadata expires

const VALID_TYPES = ['STUDENT_CARD', 'TRANSCRIPT', 'ENROLLMENT', 'TIMETABLE'];

// Clean up old job metadata on startup and periodically
const pruneJobs = () => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    if (job.createdAt && (now - job.createdAt) > JOB_TTL_MS) JOBS.delete(id);
  }
};
setInterval(pruneJobs, 60 * 60 * 1000).unref(); // every hour, non-blocking

// ── Helpers ───────────────────────────────────────────────────────────────────

const buildCampusFilter = (req) => {
  const { role, campusId } = req.user;
  if (['ADMIN', 'DIRECTOR'].includes(role)) {
    return req.query.campusId ? { schoolCampus: req.query.campusId } : {};
  }
  return { schoolCampus: campusId };
};

/**
 * Load a student document with class name resolved.
 * Attaches `_className` virtual for HTML templates.
 */
const loadStudent = async (studentId, campusId) => {
  const student = await Student
    .findOne({ _id: studentId, schoolCampus: campusId })
    .select('firstName lastName matricule profileImage dateOfBirth gender studentClass cardNumber cardValidUntil')
    .lean();

  if (!student) throw Object.assign(new Error('Student not found'), { statusCode: 404 });

  const cls = await Class.findById(student.studentClass).select('className').lean();
  student._className = cls?.className || '—';
  return student;
};

/**
 * Load students for a whole class, with class name attached.
 */
const loadStudentsByClass = async (classId, campusId) => {
  const cls = await Class.findOne({ _id: classId, schoolCampus: campusId }).select('className').lean();
  if (!cls) throw Object.assign(new Error('Class not found'), { statusCode: 404 });

  const students = await Student
    .find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule profileImage dateOfBirth gender cardNumber cardValidUntil')
    .lean();

  return students.map((s) => ({ ...s, _className: cls.className }));
};

/**
 * Load sessions for a class timetable (StudentSchedule).
 * Uses a date range if provided; otherwise the current week (Mon–Sun).
 */
const loadClassSessions = async (classId, campusId, params) => {
  const StudentSchedule = require('../models/student-models/studentSchedule.model');

  let from, to;
  if (params.weekStart) {
    from = new Date(params.weekStart);
    to   = new Date(from); to.setDate(to.getDate() + 7);
  } else {
    // Current week Mon–Sun
    from = new Date(); from.setHours(0, 0, 0, 0);
    const dow = (from.getDay() + 6) % 7;
    from.setDate(from.getDate() - dow);
    to = new Date(from); to.setDate(to.getDate() + 7);
  }

  return StudentSchedule.find({
    'classes.classId': classId,
    schoolCampus:      campusId,
    startTime:         { $gte: from, $lt: to },
    status:            { $in: ['PUBLISHED', 'DRAFT'] },
    isDeleted:         { $ne: true },
  })
    .select('subject teacher room startTime endTime')
    .lean();
};

// ── Async batch processor ─────────────────────────────────────────────────────

const processBatchJob = async (job) => {
  job.status    = 'PROCESSING';
  job.startedAt = new Date();

  for (const target of job.targets) {
    if (job.status === 'CANCELLED') break;

    try {
      let pdfData, fileName;

      // ── Build PDF data for each type ──────────────────────────────────────
      if (job.type === 'STUDENT_CARD') {
        const student = await loadStudent(target.id, job.campusId);
        const buffer  = await generateAcademicPdf({
          type: 'STUDENT_CARD', data: { student }, campusId: job.campusId, params: job.params,
        });
        const safeRef = (student.matricule || String(student._id)).toUpperCase().replace(/[^A-Z0-9]/g, '_');
        fileName      = `card_${safeRef}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);

      } else if (job.type === 'TRANSCRIPT') {
        const student    = await loadStudent(target.id, job.campusId);
        const transcript = await FinalTranscript
          .findOne({ student: target.id, schoolCampus: job.campusId, academicYear: job.params.academicYear, semester: job.params.semester })
          .lean();
        if (!transcript) {
          job.results.push({ targetId: String(target.id), targetName: target.name, error: 'No transcript found' });
          job.progress.failed++;
          job.progress.done++;
          continue;
        }
        const buffer = await generateAcademicPdf({
          type: 'TRANSCRIPT', data: { student, transcript }, campusId: job.campusId, params: job.params,
        });
        const safeRef = (student.matricule || String(student._id)).toUpperCase().replace(/[^A-Z0-9]/g, '_');
        fileName      = `transcript_${safeRef}_${job.params.academicYear?.replace('-','')}_${job.params.semester || 'S1'}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);

      } else if (job.type === 'ENROLLMENT') {
        const student = await loadStudent(target.id, job.campusId);
        const buffer  = await generateAcademicPdf({
          type: 'ENROLLMENT', data: { student }, campusId: job.campusId, params: job.params,
        });
        const safeRef = (student.matricule || String(student._id)).toUpperCase().replace(/[^A-Z0-9]/g, '_');
        fileName      = `cert_${safeRef}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);

      } else if (job.type === 'TIMETABLE') {
        const cls      = await Class.findById(target.id).select('className').lean();
        const sessions = await loadClassSessions(target.id, job.campusId, job.params);
        const buffer   = await generateAcademicPdf({
          type: 'TIMETABLE', data: { sessions, cls }, campusId: job.campusId, params: job.params,
        });
        const safeName = (cls?.className || String(target.id)).replace(/[^A-Z0-9a-z]/g, '_');
        fileName       = `timetable_${safeName}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);
      }

      job.results.push({ targetId: String(target.id), targetName: target.name, fileName, completedAt: new Date() });
      job.progress.done++;

    } catch (err) {
      job.results.push({ targetId: String(target.id), targetName: target.name, error: err.message, failedAt: new Date() });
      job.progress.failed++;
      job.progress.done++;
    }
  }

  job.status      = job.progress.failed === job.progress.total ? 'ERROR'
    : job.progress.failed > 0 ? 'PARTIAL'
    : 'DONE';
  job.completedAt = new Date();
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
  const campusId = req.user.campusId;

  if (!VALID_TYPES.includes(type)) return sendError(res, 400, `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);

  let buffer;

  if (type === 'STUDENT_CARD' || type === 'ENROLLMENT') {
    if (!studentId) return sendError(res, 400, 'studentId is required');
    const student = await loadStudent(studentId, campusId);
    buffer = await generateAcademicPdf({ type, data: { student }, campusId, params });

  } else if (type === 'TRANSCRIPT') {
    if (!studentId) return sendError(res, 400, 'studentId is required');
    if (!params.academicYear || !params.semester) return sendError(res, 400, 'params.academicYear and params.semester are required');
    const student    = await loadStudent(studentId, campusId);
    const transcript = await FinalTranscript
      .findOne({ student: studentId, schoolCampus: campusId, academicYear: params.academicYear, semester: params.semester })
      .lean();
    if (!transcript) return sendError(res, 404, 'No transcript found for this student / academic year / semester');
    buffer = await generateAcademicPdf({ type: 'TRANSCRIPT', data: { student, transcript }, campusId, params });

  } else if (type === 'TIMETABLE') {
    if (!classId) return sendError(res, 400, 'classId is required for TIMETABLE');
    const cls      = await Class.findOne({ _id: classId, schoolCampus: campusId }).select('className').lean();
    if (!cls) return sendError(res, 404, 'Class not found');
    const sessions = await loadClassSessions(classId, campusId, params);
    buffer = await generateAcademicPdf({ type: 'TIMETABLE', data: { sessions, cls }, campusId, params });
  }

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
  const campusId = req.user.campusId;
  const { page = 1, limit = 20 } = req.query;

  const campusJobs = [...JOBS.values()]
    .filter((j) => String(j.campusId) === String(campusId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const pageNum   = Math.max(1, parseInt(page, 10));
  const limitNum  = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const paged     = campusJobs.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  return sendPaginated(res, 200, 'Print jobs fetched.', paged.map((j) => ({
    id:          j.id,
    type:        j.type,
    status:      j.status,
    progress:    j.progress,
    params:      j.params,
    startedAt:   j.startedAt,
    completedAt: j.completedAt,
    createdAt:   j.createdAt,
  })), { total: campusJobs.length, page: pageNum, limit: limitNum });
});

/**
 * POST /api/print/batch
 * Enqueue a batch print job for a whole class or a list of student IDs.
 *
 * Body: {
 *   type,
 *   classId?,      // generate for all students in the class (STUDENT_CARD, TRANSCRIPT, ENROLLMENT)
 *                  // or all sessions for the class (TIMETABLE)
 *   studentIds?,   // explicit list (overrides classId for student types)
 *   params: { academicYear, semester, weekStart, cardNumber, cardValidUntil }
 * }
 */
const startBatch = asyncHandler(async (req, res) => {
  const { type, classId, studentIds, params = {} } = req.body;
  const campusId    = req.user.campusId;
  const requestedBy = req.user.id;

  if (!VALID_TYPES.includes(type)) return sendError(res, 400, `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);

  let targets = [];

  if (type === 'TIMETABLE') {
    // Timetable batch: one PDF per class
    if (!classId) return sendError(res, 400, 'classId is required for TIMETABLE batch');
    const cls = await Class.findOne({ _id: classId, schoolCampus: campusId }).select('className').lean();
    if (!cls) return sendError(res, 404, 'Class not found');
    targets = [{ id: String(classId), name: cls.className }];

  } else {
    // Student-type batches
    if (studentIds && Array.isArray(studentIds) && studentIds.length > 0) {
      const students = await Student
        .find({ _id: { $in: studentIds }, schoolCampus: campusId })
        .select('firstName lastName matricule')
        .lean();
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

  const jobId = crypto.randomUUID();
  const job   = {
    id:          jobId,
    campusId:    String(campusId),
    type,
    status:      'PENDING',
    params,
    targets,
    results:     [],
    progress:    { total: targets.length, done: 0, failed: 0 },
    requestedBy,
    createdAt:   Date.now(),
    startedAt:   null,
    completedAt: null,
  };

  JOBS.set(jobId, job);

  // Fire-and-forget async processing
  processBatchJob(job).catch((err) => {
    console.error(`[PrintBatch] Job ${jobId} failed fatally:`, err.message);
    job.status = 'ERROR';
    job.completedAt = new Date();
  });

  return sendSuccess(res, 202, 'Batch job started.', { jobId, total: targets.length });
});

/**
 * GET /api/print/batch/:jobId
 * Get status and results of a batch job.
 */
const getBatchJobStatus = asyncHandler(async (req, res) => {
  const { jobId }  = req.params;
  const campusId   = req.user.campusId;
  const job        = JOBS.get(jobId);

  if (!job || String(job.campusId) !== String(campusId)) {
    return sendError(res, 404, 'Job not found');
  }

  return sendSuccess(res, 200, 'Job status fetched.', {
    id:          job.id,
    type:        job.type,
    status:      job.status,
    progress:    job.progress,
    params:      job.params,
    results:     job.results,
    startedAt:   job.startedAt,
    completedAt: job.completedAt,
    createdAt:   new Date(job.createdAt),
  });
});

/**
 * GET /api/print/batch/:jobId/download/:fileName
 * Stream a result PDF from a completed batch job.
 */
const downloadBatchResult = asyncHandler(async (req, res) => {
  const { jobId, fileName } = req.params;
  const campusId = req.user.campusId;

  const job = JOBS.get(jobId);
  if (!job || String(job.campusId) !== String(campusId)) return sendError(res, 404, 'Job not found');

  // Verify this fileName belongs to this job (security: prevent path traversal)
  const isOwned = job.results.some((r) => r.fileName === fileName);
  if (!isOwned) return sendError(res, 403, 'File does not belong to this job');

  // Sanitize fileName: only allow safe characters
  if (!/^[\w.-]+\.pdf$/.test(fileName)) return sendError(res, 400, 'Invalid file name');

  const buffer = await readPrintPdf(campusId, fileName);

  res.set({
    'Content-Type':        'application/pdf',
    'Content-Length':      buffer.length,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control':       'private, max-age=3600',
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
