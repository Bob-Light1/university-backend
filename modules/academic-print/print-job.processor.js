'use strict';

/**
 * @file print-job.processor.js — batch print queue worker + shared data loaders.
 *
 * Two responsibilities:
 *   1. Shared loaders (student / class sessions / class teachers) used by BOTH
 *      the synchronous preview (controller) and the async batch (this file).
 *   2. The queue worker: atomically claim a PENDING job, render & persist each
 *      target's PDF, update progress, finalize. Triggered inline by the API
 *      (`kick`) for low latency AND swept by a cron (`runPrintQueueJob`) so a
 *      crash mid-processing or a missed inline kick still gets recovered.
 *
 * Job state lives in MongoDB (see print-job.model.js) → reachable from any worker.
 */

const repo = require('./print-job.repository');
const { generateAcademicPdf, savePrintPdf } = require('./academic-pdf.service');

const studentService = require('../student').service;
const { getClassName, getClassNameInCampus } = require('../class').service;
const resultService  = require('../result').service;

// A PROCESSING job whose worker hasn't touched it within this window is presumed
// dead and requeued by the sweep cron.
const STALE_MS = parseInt(process.env.PRINT_JOB_STALE_MS || String(15 * 60 * 1000), 10);

// ── Shared data loaders ───────────────────────────────────────────────────────

/** Load a student with the class name attached (`_className` for templates). */
const loadStudent = async (studentId, campusId) => {
  const student = await studentService.getStudentForPrint(studentId, campusId);
  if (!student) throw Object.assign(new Error('Student not found'), { statusCode: 404 });

  const cls = await getClassName(student.studentClass);
  student._className = cls?.className || '—';
  return student;
};

/** Load all (non-archived) students of a class, with the class name attached. */
const loadStudentsByClass = async (classId, campusId) => {
  const cls = await getClassNameInCampus(classId, campusId);
  if (!cls) throw Object.assign(new Error('Class not found'), { statusCode: 404 });

  const students = await studentService.listClassStudentsForCards(classId, campusId);
  return students.map((s) => ({ ...s, _className: cls.className }));
};

/** Unique teachers (with their subjects) across all sessions of a class. */
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
    // Dedup on the real teacher ref (teacherId); fall back to name only if absent.
    const id = s.teacher.teacherId
      ? String(s.teacher.teacherId)
      : `${s.teacher.firstName || ''}_${s.teacher.lastName || ''}`;
    if (!teacherMap.has(id)) {
      teacherMap.set(id, {
        fullName: `${s.teacher.firstName || ''} ${s.teacher.lastName || ''}`.trim(),
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
 * Sessions for a class timetable over a week (StudentSchedule). Uses params.weekStart
 * if provided; otherwise the current Mon–Sun week.
 */
const loadClassSessions = async (classId, campusId, params = {}) => {
  let from, to;
  if (params.weekStart) {
    from = new Date(params.weekStart);
    to   = new Date(from); to.setDate(to.getDate() + 7);
  } else {
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

// ── Per-target PDF generation ─────────────────────────────────────────────────

const safeRef = (student) =>
  (student.matricule || String(student._id)).toUpperCase().replace(/[^A-Z0-9]/g, '_');

const safeName = (cls, fallbackId) =>
  (cls?.className || String(fallbackId)).replace(/[^A-Z0-9a-z]/g, '_');

/**
 * Generate and persist one target's PDF. Returns { fileName }.
 * Throws (with statusCode where relevant) on unrecoverable target errors.
 */
const generateForTarget = async (job, target) => {
  const { type, campusId, params } = job;
  const locale = params?.locale || 'en';

  if (type === 'STUDENT_CARD' || type === 'ENROLLMENT') {
    const student = await loadStudent(target.id, campusId);
    const buffer  = await generateAcademicPdf({ type, data: { student }, campusId, params, locale });
    const prefix  = type === 'STUDENT_CARD' ? 'card' : 'cert';
    const fileName = `${prefix}_${safeRef(student)}_${Date.now()}.pdf`;
    await savePrintPdf(buffer, campusId, fileName);
    return { fileName };
  }

  if (type === 'TRANSCRIPT') {
    const student    = await loadStudent(target.id, campusId);
    const transcript = await resultService.getTranscriptForPrint({
      studentId: target.id, campusId,
      academicYear: params.academicYear, semester: params.semester,
    });
    if (!transcript) throw Object.assign(new Error('No transcript found'), { statusCode: 404 });
    const buffer = await generateAcademicPdf({ type, data: { student, transcript }, campusId, params, locale });
    const fileName = `transcript_${safeRef(student)}_${(params.academicYear || '').replace(/-/g, '')}_${params.semester || 'S1'}_${Date.now()}.pdf`;
    await savePrintPdf(buffer, campusId, fileName);
    return { fileName };
  }

  if (type === 'TIMETABLE') {
    const cls      = await getClassName(target.id);
    const sessions = await loadClassSessions(target.id, campusId, params);
    const buffer   = await generateAcademicPdf({ type, data: { sessions, cls }, campusId, params, locale });
    const fileName = `timetable_${safeName(cls, target.id)}_${Date.now()}.pdf`;
    await savePrintPdf(buffer, campusId, fileName);
    return { fileName };
  }

  if (type === 'STUDENT_LIST') {
    const cls      = await getClassName(target.id);
    const students = await studentService.listClassStudentsForList(target.id, campusId);
    const buffer   = await generateAcademicPdf({ type, data: { students, cls }, campusId, params, locale });
    const fileName = `student_list_${safeName(cls, target.id)}_${Date.now()}.pdf`;
    await savePrintPdf(buffer, campusId, fileName);
    return { fileName };
  }

  if (type === 'TEACHER_LIST') {
    const cls      = await getClassName(target.id);
    const teachers = await loadClassTeachers(target.id, campusId);
    const buffer   = await generateAcademicPdf({ type, data: { teachers, cls }, campusId, params, locale });
    const fileName = `teacher_list_${safeName(cls, target.id)}_${Date.now()}.pdf`;
    await savePrintPdf(buffer, campusId, fileName);
    return { fileName };
  }

  throw Object.assign(new Error(`Unknown job type: ${type}`), { statusCode: 400 });
};

// ── Job processing ────────────────────────────────────────────────────────────

/**
 * Process every target of an already-claimed job, updating progress atomically.
 * Honors external cancellation (status flipped to CANCELLED between targets).
 */
const processJob = async (job) => {
  const jobId = job._id;
  const total = job.progress?.total ?? job.targets.length;
  let failed  = 0;

  for (const target of job.targets) {
    // Heartbeat + stop signal in one atomic call: refreshes workerClaimedAt (so a
    // long batch isn't requeued as stale) and returns null if the job was cancelled,
    // deleted, or already finalized — in which case we stop.
    const cur = await repo.touchProcessing(jobId);
    if (!cur) return;

    try {
      const { fileName } = await generateForTarget(job, target);
      await repo.pushSuccess(jobId, {
        targetId: String(target.id), targetName: target.name, fileName, completedAt: new Date(),
      });
    } catch (err) {
      failed++;
      await repo.pushFailure(jobId, {
        targetId: String(target.id), targetName: target.name, error: err.message, failedAt: new Date(),
      });
    }
  }

  const status = total === 0 ? 'DONE'
    : failed === total ? 'ERROR'
    : failed > 0 ? 'PARTIAL'
    : 'DONE';
  await repo.finalize(jobId, status);
};

/**
 * Atomically claim a job by id and process it. Returns true if THIS worker ran it,
 * false if it was already claimed by another worker (or no longer PENDING).
 */
const claimAndProcess = async (jobId) => {
  const job = await repo.claim(jobId);
  if (!job) return false;
  await processJob(job);
  return true;
};

/** Best-effort inline trigger right after enqueue (fire-and-forget, low latency). */
const kick = (jobId) => {
  claimAndProcess(jobId).catch((err) => {
    console.error(`[PrintQueue] Job ${jobId} failed:`, err.message);
    repo.finalize(jobId, 'ERROR').catch(() => {});
  });
};

/**
 * Cron sweep: requeue stale PROCESSING jobs (dead workers), then claim & process
 * any PENDING jobs left behind (e.g. crash right after enqueue, or another worker
 * never kicked). Idempotent and safe to run on every node — claims are atomic.
 * @returns {Promise<number>} jobs processed by this run
 */
const runPrintQueueJob = async () => {
  await repo.requeueStale(new Date(Date.now() - STALE_MS));

  const pending = await repo.findClaimablePendingIds(20);
  let processed = 0;
  for (const { _id } of pending) {
    const ran = await claimAndProcess(_id).catch((err) => {
      console.error(`[PrintQueue] Sweep failed for job ${_id}:`, err.message);
      return repo.finalize(_id, 'ERROR').then(() => false).catch(() => false);
    });
    if (ran) processed++;
  }
  return processed;
};

module.exports = {
  // shared loaders (consumed by the controller's preview path)
  loadStudent,
  loadStudentsByClass,
  loadClassTeachers,
  loadClassSessions,
  // queue worker
  kick,
  runPrintQueueJob,
};
