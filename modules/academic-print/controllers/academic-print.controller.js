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

const { asyncHandler, sendSuccess, sendError, sendPaginated } = require('../../../shared/utils/response-helpers');
const { generateAcademicPdf, savePrintPdf, readPrintPdf }    = require('../academic-pdf.service');

const studentService  = require('../../student').service; // student module facade (§3)
const { getClassName, getClassNameInCampus } = require('../../class').service; // class module facade (§3)
const resultService   = require('../../result').service; // result module facade (§3)

// ── In-process job store ──────────────────────────────────────────────────────
// Structure: Map<jobId, JobRecord>
// JobRecord: { id, campusId, type, status, params, targets, results, progress, startedAt, completedAt, requestedBy }

const JOBS = new Map();
const JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days before job metadata expires

const VALID_TYPES = ['STUDENT_CARD', 'TRANSCRIPT', 'ENROLLMENT', 'TIMETABLE', 'STUDENT_LIST', 'TEACHER_LIST'];

// Types that produce one PDF per class (not per student)
const CLASS_LEVEL_TYPES = ['TIMETABLE', 'STUDENT_LIST', 'TEACHER_LIST'];

// Clean up old job metadata on startup and periodically
const pruneJobs = () => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    if (job.createdAt && (now - job.createdAt) > JOB_TTL_MS) JOBS.delete(id);
  }
};
setInterval(pruneJobs, 60 * 60 * 1000).unref(); // every hour, non-blocking

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
  const student = await studentService.getStudentForPrint(studentId, campusId);

  if (!student) throw Object.assign(new Error('Student not found'), { statusCode: 404 });

  const cls = await getClassName(student.studentClass);
  student._className = cls?.className || '—';
  return student;
};

/**
 * Load students for a whole class, with class name attached.
 */
const loadStudentsByClass = async (classId, campusId) => {
  const cls = await getClassNameInCampus(classId, campusId);
  if (!cls) throw Object.assign(new Error('Class not found'), { statusCode: 404 });

  const students = await studentService.listClassStudentsForCards(classId, campusId);

  return students.map((s) => ({ ...s, _className: cls.className }));
};

/**
 * Extract unique teachers (with their subjects) from all sessions of a class.
 * No date filter — returns the full instructor roster.
 */
const loadClassTeachers = async (classId, campusId) => {
  const sessions = await studentService.listSessionsForClass({
    classId,
    campusId,
    statuses:        ['PUBLISHED', 'DRAFT'],
    isDeletedFilter: { $ne: true },
    select:          'subject teacher',
    sort:            null,
  });

  const teacherMap = new Map();
  for (const s of sessions) {
    if (!s.teacher) continue;
    const id = s.teacher._id
      ? String(s.teacher._id)
      : `${s.teacher.firstName || ''}_${s.teacher.lastName || ''}`;
    if (!teacherMap.has(id)) {
      teacherMap.set(id, {
        fullName: s.teacher.fullName || `${s.teacher.firstName || ''} ${s.teacher.lastName || ''}`.trim(),
        subjects: new Set(),
      });
    }
    if (s.subject?.subject_name) teacherMap.get(id).subjects.add(s.subject.subject_name);
  }

  return [...teacherMap.values()]
    .map((t) => ({ fullName: t.fullName, subjects: [...t.subjects] }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
};

/**
 * Load sessions for a class timetable (StudentSchedule).
 * Uses a date range if provided; otherwise the current week (Mon–Sun).
 */
const loadClassSessions = async (classId, campusId, params) => {
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

  return studentService.listSessionsForClass({
    classId,
    campusId,
    from,
    toExclusive:     to,
    statuses:        ['PUBLISHED', 'DRAFT'],
    isDeletedFilter: { $ne: true },
    select:          'subject teacher room startTime endTime',
    sort:            null,
  });
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
        const transcript = await resultService.getTranscriptForPrint({
          studentId: target.id, campusId: job.campusId,
          academicYear: job.params.academicYear, semester: job.params.semester,
        });
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
        const cls      = await getClassName(target.id);
        const sessions = await loadClassSessions(target.id, job.campusId, job.params);
        const buffer   = await generateAcademicPdf({
          type: 'TIMETABLE', data: { sessions, cls }, campusId: job.campusId, params: job.params,
        });
        const safeName = (cls?.className || String(target.id)).replace(/[^A-Z0-9a-z]/g, '_');
        fileName       = `timetable_${safeName}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);

      } else if (job.type === 'STUDENT_LIST') {
        const cls      = await getClassName(target.id);
        const students = await studentService.listClassStudentsForList(target.id, job.campusId);
        const buffer   = await generateAcademicPdf({
          type: 'STUDENT_LIST', data: { students, cls }, campusId: job.campusId, params: job.params,
        });
        const safeName = (cls?.className || String(target.id)).replace(/[^A-Z0-9a-z]/g, '_');
        fileName       = `student_list_${safeName}_${Date.now()}.pdf`;
        await savePrintPdf(buffer, job.campusId, fileName);

      } else if (job.type === 'TEACHER_LIST') {
        const cls      = await getClassName(target.id);
        const teachers = await loadClassTeachers(target.id, job.campusId);
        const buffer   = await generateAcademicPdf({
          type: 'TEACHER_LIST', data: { teachers, cls }, campusId: job.campusId, params: job.params,
        });
        const safeName = (cls?.className || String(target.id)).replace(/[^A-Z0-9a-z]/g, '_');
        fileName       = `teacher_list_${safeName}_${Date.now()}.pdf`;
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
  const campusId = resolveCampusId(req);

  if (!campusId) return sendError(res, 400, 'campusId is required for ADMIN/DIRECTOR — pass it in the request body.');
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
    const transcript = await resultService.getTranscriptForPrint({
      studentId, campusId,
      academicYear: params.academicYear, semester: params.semester,
    });
    if (!transcript) return sendError(res, 404, 'No transcript found for this student / academic year / semester');
    buffer = await generateAcademicPdf({ type: 'TRANSCRIPT', data: { student, transcript }, campusId, params });

  } else if (type === 'TIMETABLE') {
    if (!classId) return sendError(res, 400, 'classId is required for TIMETABLE');
    const cls      = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const sessions = await loadClassSessions(classId, campusId, params);
    buffer = await generateAcademicPdf({ type: 'TIMETABLE', data: { sessions, cls }, campusId, params });

  } else if (type === 'STUDENT_LIST') {
    if (!classId) return sendError(res, 400, 'classId is required for STUDENT_LIST');
    const cls = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const students = await studentService.listClassStudentsForList(classId, campusId);
    buffer = await generateAcademicPdf({ type: 'STUDENT_LIST', data: { students, cls }, campusId, params });

  } else if (type === 'TEACHER_LIST') {
    if (!classId) return sendError(res, 400, 'classId is required for TEACHER_LIST');
    const cls = await getClassNameInCampus(classId, campusId);
    if (!cls) return sendError(res, 404, 'Class not found');
    const teachers = await loadClassTeachers(classId, campusId);
    buffer = await generateAcademicPdf({ type: 'TEACHER_LIST', data: { teachers, cls }, campusId, params });
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
  const campusId = resolveCampusId(req);
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
  const campusId    = resolveCampusId(req);
  const requestedBy = req.user.id;

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
  const campusId   = resolveCampusId(req);
  const job        = JOBS.get(jobId);

  if (!job || (campusId && String(job.campusId) !== String(campusId))) {
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
  const campusId = resolveCampusId(req);

  const job = JOBS.get(jobId);
  if (!job || (campusId && String(job.campusId) !== String(campusId))) return sendError(res, 404, 'Job not found');

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
