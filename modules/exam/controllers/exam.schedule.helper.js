'use strict';

/**
 * @file exam.schedule.helper.js
 * @description Syncs ExamSession state into StudentSchedule / TeacherSchedule
 *              so that published exams appear in all schedule views
 *              (Campus Manager, Teacher, Student, Parent).
 *
 *  Entry points:
 *    injectExamIntoSchedule(sessionId)  — called on DRAFT → SCHEDULED
 *    syncExamScheduleStatus(sessionId, newStatus, timeUpdate?)
 *                                        — called on cancel / postpone / reschedule
 */

const repo            = require('../exam.repository');
// Requires paresseux : student.dashboard et teacher.dashboard consomment la
// façade exam (cycles exam ↔ student et exam ↔ teacher)
const studentService  = () => require('../../student').service;
const teacherService  = () => require('../../teacher').service;
const { SCHEDULE_STATUS } = require('../../../shared/utils/schedule.base');

// ── Status mapping: ExamSession.status → SCHEDULE_STATUS ─────────────────────

const EXAM_TO_SCHEDULE_STATUS = {
  SCHEDULED: SCHEDULE_STATUS.PUBLISHED,
  CANCELLED: SCHEDULE_STATUS.CANCELLED,
  POSTPONED: SCHEDULE_STATUS.POSTPONED,
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates StudentSchedule + TeacherSchedule entries for an exam
 * session. Idempotent — safe to call multiple times (upsert by reference).
 *
 * @param {string|ObjectId} sessionId
 */
const injectExamIntoSchedule = async (sessionId) => {
  const session = await repo.findSessionForScheduleInjection(sessionId);

  if (!session) return;

  const isVirtual = session.mode === 'ONLINE';

  const subjectData = {
    subjectId:    session.subject?._id   || null,
    subject_name: session.subject?.subject_name || session.title,
    subject_code: session.subject?.subject_code || '',
    coefficient:  session.subject?.coefficient  || null,
  };

  const teacherData = {
    teacherId: session.teacher?._id    || null,
    firstName: session.teacher?.firstName || '',
    lastName:  session.teacher?.lastName  || '',
    email:     session.teacher?.email     || '',
  };

  const scheduleClasses = (session.classes || []).map((c) => ({
    classId:   c._id,
    className: c.className || c.name || '',
    level:     c.level || null,
  }));

  const ssRef = `EXAM-SS-${session._id}`;
  const tsRef = `EXAM-TS-${session._id}`;

  const studentFields = {
    reference:    ssRef,
    schoolCampus: session.schoolCampus,
    academicYear: session.academicYear,
    semester:     session.semester,
    subject:      subjectData,
    sessionType:  'EXAM',
    startTime:    session.startTime,
    endTime:      session.endTime,
    teacher:      teacherData,
    classes:      scheduleClasses,
    isVirtual,
    status:       SCHEDULE_STATUS.PUBLISHED,
    publishedAt:  new Date(),
    topic:        session.title,
    description:  session.instructions || '',
  };

  const teacherFields = {
    reference:    tsRef,
    schoolCampus: session.schoolCampus,
    academicYear: session.academicYear,
    semester:     session.semester,
    subject:      subjectData,
    sessionType:  'EXAM',
    startTime:    session.startTime,
    endTime:      session.endTime,
    teacher:      teacherData,
    classes:      scheduleClasses,
    isVirtual,
    status:       SCHEDULE_STATUS.PUBLISHED,
    publishedAt:  new Date(),
  };

  await Promise.all([
    studentService().upsertStudentScheduleByReference(ssRef, studentFields),
    teacherService().upsertTeacherScheduleByReference(tsRef, teacherFields),
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Syncs the status (and optionally new times) of the schedule entries
 * that were created for an exam session.
 *
 * @param {string|ObjectId} sessionId
 * @param {'CANCELLED'|'POSTPONED'|'SCHEDULED'} examStatus
 * @param {{ startTime?: Date, endTime?: Date }} [timeUpdate]
 */
const syncExamScheduleStatus = async (sessionId, examStatus, timeUpdate = {}) => {
  const scheduleStatus = EXAM_TO_SCHEDULE_STATUS[examStatus];
  if (!scheduleStatus) return;

  const update = { status: scheduleStatus };
  if (timeUpdate.startTime) update.startTime = timeUpdate.startTime;
  if (timeUpdate.endTime)   update.endTime   = timeUpdate.endTime;

  const ssRef = `EXAM-SS-${sessionId}`;
  const tsRef = `EXAM-TS-${sessionId}`;

  await Promise.all([
    studentService().updateStudentScheduleByReference(ssRef, update),
    teacherService().updateTeacherScheduleByReference(tsRef, update),
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { injectExamIntoSchedule, syncExamScheduleStatus };
