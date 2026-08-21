'use strict';

/**
 * @file records.builder.js
 * @description Academic records: results, and one exam cycle per campus carried
 * all the way to a published grading.
 *
 * Two of the three deletion traps of §4.3 are materialised here, and they are
 * the reason this builder exists at all:
 *
 *   - five results are soft-deleted while KEEPING `status: 'PUBLISHED'`;
 *   - three results sit in `status: 'ARCHIVED'` and are LIVE — `Result.status`
 *     is a workflow state, never a deletion marker (CLAUDE.md §5.1).
 *
 * A suite that runs against a fixture without both cases proves nothing about
 * the deletion filters: `{ status: { $ne: 'archived' } }` on results is green
 * and wrong.
 */

const { oid, pad, token, stamps } = require('../ids');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR } = require('../seed.config');

const EVALUATION_TYPES = ['CC', 'EXAM', 'PROJECT', 'PRACTICAL'];

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @param {{ next: number }} sequence - Shared result reference counter.
 * @returns {Object[]}
 */
const buildResults = (campusKey, ctx, sequence) => {
  const counts = COUNTS[campusKey];
  const students = ctx.students[campusKey];
  const teacher = ctx.teachers[campusKey][0];

  return Array.from({ length: counts.results }, (_, i) => {
    const n = pad(i + 1);
    const rank = i + 1;
    const student = students[i % students.length];
    const subjectIndex = (i % counts.subjects) + 1;
    const score = 8 + (i % 12);
    const maxScore = 20;

    // Last N are soft-deleted; the N before them are ARCHIVED-but-live.
    const deleted = rank > counts.results - counts.resultsDeleted;
    const archivedAlive = !deleted
      && rank > counts.results - counts.resultsDeleted - counts.resultsArchivedAlive;

    const reference = `RES-${ctx.anchorYear}-${String(sequence.next++).padStart(5, '0')}`;

    return {
      _id: oid(`result:${campusKey}:${n}`),
      reference,
      schoolCampus: ctx.campusIds[campusKey],
      academicYear: ACADEMIC_YEAR,
      semester: i % 2 === 0 ? 'S1' : 'S2',
      evaluationType: EVALUATION_TYPES[i % EVALUATION_TYPES.length],
      evaluationTitle: `Evaluation ${campusKey}${rank}`,
      examDate: ctx.at(-90 + (i % 30)),
      examPeriod: i % 2 === 0 ? 'Midterm' : 'Final',
      examAttendance: 'present',
      student: student._id,
      class: student.studentClass,
      subject: oid(`subject:${campusKey}:${pad(subjectIndex)}`),
      teacher: teacher._id,
      classManager: teacher._id,
      score,
      maxScore,
      coefficient: 1,
      // Computed in `pre('save')`, which `insertMany` does not run — written
      // here so a published result carries the value the UI reads.
      normalizedScore: Number(((score / maxScore) * 20).toFixed(2)),
      gradingScale: oid(`grading-scale:${campusKey}`),
      teacherRemarks: 'Fixture remark',
      // `status` stays PUBLISHED on the soft-deleted rows on purpose: a deleted
      // result keeps its workflow state, and only `isDeleted` says it is gone.
      status: archivedAlive ? 'ARCHIVED' : 'PUBLISHED',
      publishedAt: ctx.at(-80 + (i % 30)),
      publishedBy: String(teacher._id),
      ...(archivedAlive ? { archivedAt: ctx.at(-10), archivedBy: String(teacher._id) } : {}),
      verificationToken: token(`result:${campusKey}:${n}`),
      ...stamps(120 - (i % 60)),
      ...(deleted ? ctx.softDelete('Result', ctx.at(-15)) : { isDeleted: false }),
    };
  });
};

/**
 * One exam cycle per campus: sessions, the roster of the first class, the papers
 * actually sat, and their gradings. One enrolled student sits no paper, so the
 * "enrolled but absent" branch has a row.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {{ sessions: Object[], enrollments: Object[], submissions: Object[], gradings: Object[] }}
 */
const buildExamCycle = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const campusId = ctx.campusIds[campusKey];
  const teacher = ctx.teachers[campusKey][0];
  const firstClassId = String(oid(`class:${campusKey}:001`));
  const roster = (ctx.studentsByClass[firstClassId] || []).slice(0, counts.examEnrollments);

  const sessions = Array.from({ length: counts.examSessions }, (_, i) => ({
    _id: oid(`exam-session:${campusKey}:${pad(i + 1)}`),
    schoolCampus: campusId,
    title: `Exam session ${campusKey}${i + 1}`,
    subject: oid(`subject:${campusKey}:${pad(i + 1)}`),
    classes: [oid(`class:${campusKey}:001`)],
    teacher: teacher._id,
    invigilators: [teacher._id],
    academicYear: ACADEMIC_YEAR,
    semester: 'S2',
    examPeriod: i === 0 ? 'FINAL' : 'MIDTERM',
    mode: 'PHYSICAL',
    status: i === 0 ? 'COMPLETED' : 'SCHEDULED',
    startTime: i === 0 ? ctx.at(-20, 0) : ctx.at(20, 0),
    endTime: i === 0 ? ctx.at(-20, 2) : ctx.at(20, 2),
    duration: 120,
    room: { code: `R-${campusKey}1`, name: `Room ${campusKey}1`, capacity: 50 },
    maxScore: 20,
    gradingScale: oid(`grading-scale:${campusKey}`),
    instructions: 'Fixture exam instructions',
    createdBy: ctx.adminIds.ADMIN,
    isDeleted: false,
    ...(i === 0 ? { completedAt: ctx.at(-20, 3), publishedAt: ctx.at(-25) } : {}),
    ...stamps(45),
  }));

  const sessionId = sessions[0]._id;

  const enrollments = roster.map((studentId, i) => ({
    _id: oid(`exam-enrollment:${campusKey}:${pad(i + 1)}`),
    schoolCampus: campusId,
    examSession: sessionId,
    student: studentId,
    isEligible: true,
    seatNumber: `S${pad(i + 1)}`,
    hallTicketToken: token(`hall-ticket:${campusKey}:${pad(i + 1)}`),
    checkedInAt: i < counts.examSubmissions ? ctx.at(-20, -1) : undefined,
    checkedInBy: i < counts.examSubmissions ? teacher._id : undefined,
    attendance: i < counts.examSubmissions ? 'PRESENT' : 'ABSENT',
    identityVerified: i < counts.examSubmissions,
    isDeleted: false,
    createdBy: ctx.adminIds.ADMIN,
    ...stamps(44),
  }));

  const submissions = roster.slice(0, counts.examSubmissions).map((studentId, i) => ({
    _id: oid(`exam-submission:${campusKey}:${pad(i + 1)}`),
    schoolCampus: campusId,
    examSession: sessionId,
    student: studentId,
    startedAt: ctx.at(-20, 0),
    submittedAt: ctx.at(-20, 2),
    status: 'GRADED',
    tabSwitchCount: 0,
    isDeleted: false,
    ...stamps(43),
  }));

  const gradings = submissions.slice(0, counts.examGradings).map((submission, i) => {
    const score = 11 + i;

    return {
      _id: oid(`exam-grading:${campusKey}:${pad(i + 1)}`),
      schoolCampus: campusId,
      submission: submission._id,
      examSession: sessionId,
      student: submission.student,
      grader: teacher._id,
      score,
      maxScore: 20,
      normalizedScore: Number(((score / 20) * 20).toFixed(2)),
      finalScore: score,
      graderFeedback: 'Fixture feedback',
      status: 'PUBLISHED',
      publishedAt: ctx.at(-18),
      certificateToken: token(`certificate:${campusKey}:${pad(i + 1)}`),
      isDeleted: false,
      ...stamps(42),
    };
  });

  return { sessions, enrollments, submissions, gradings };
};

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const build = (ctx) => {
  const sequence = { next: 1 };
  const results = CAMPUS_KEYS.flatMap((key) => buildResults(key, ctx, sequence));
  const cycles = CAMPUS_KEYS.map((key) => buildExamCycle(key, ctx));

  // The application mints result references from a counter; the seed realigns it
  // afterwards so the first result created by a test does not collide (§4.8).
  ctx.resultCount = results.length;

  return [
    { model: 'Result', docs: results },
    { model: 'ExamSession', docs: cycles.flatMap((c) => c.sessions) },
    { model: 'ExamEnrollment', docs: cycles.flatMap((c) => c.enrollments) },
    { model: 'ExamSubmission', docs: cycles.flatMap((c) => c.submissions) },
    { model: 'ExamGrading', docs: cycles.flatMap((c) => c.gradings) },
  ];
};

module.exports = { build };
