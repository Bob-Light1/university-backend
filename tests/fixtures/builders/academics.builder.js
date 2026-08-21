'use strict';

/**
 * @file academics.builder.js
 * @description Academic structure of the fixture, in two passes because the
 * dependency chain crosses the actor builder:
 *
 *   buildFoundation() → Level, Department, Course, GradingScale   (before actors:
 *                       Teacher declares a REQUIRED `department`)
 *   buildTeaching()   → Subject, Class, StudentSchedule, TeacherSchedule
 *                       (after actors: `Class.pre('validate')` reads the class
 *                        manager back from the Teacher collection)
 *
 * `Level` and `Course` carry no campus path at all — see D-21 for `Level`, whose
 * per-campus split in §4.3 the schema does not support.
 */

const { oid, pad, stamps } = require('../ids');
const { COUNTS, ACADEMIC_YEAR, CAMPUS_KEYS } = require('../seed.config');

/** Weekday slots of the seeded teaching week, from the anchor Monday. */
const WEEK_DAYS = [0, 1, 2, 3, 4];

/**
 * Global levels. §4.3 splits them 3 / 2 across campuses; the schema declares no
 * campus path and the hard-delete registry declares `campusPath: null`, so the
 * five are seeded once and shared (decision D-21).
 *
 * @returns {Object[]}
 */
const buildLevels = () =>
  Array.from({ length: COUNTS.GLOBAL.levels }, (_, i) => ({
    _id: oid(`level:${pad(i + 1)}`),
    name: `Fixture Level ${i + 1}`,
    code: `LVL${i + 1}`,
    type: 'ACADEMIC',
    order: i + 1,
    description: `Deterministic fixture level ${i + 1}`,
    status: 'active',
    ...stamps(380),
  }));

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildDepartments = (campusKey, ctx) =>
  Array.from({ length: COUNTS[campusKey].departments }, (_, i) => ({
    _id: oid(`department:${campusKey}:${pad(i + 1)}`),
    name: `Department ${campusKey}${i + 1}`,
    code: `DEP-${campusKey}${i + 1}`,
    description: `Fixture department ${campusKey}${i + 1}`,
    schoolCampus: ctx.campusIds[campusKey],
    // headOfDepartment stays null: it is a DETACH relation of the hard-delete
    // registry, and pinning it here would make the teacher rows undeletable for
    // a reason the fixture invented.
    status: 'active',
    ...stamps(375),
  }));

/**
 * Global course catalogue. `createdBy` is a REQUIRED Teacher ref — a RETAIN
 * relation in the registry, so it deliberately survives its author.
 *
 * @returns {Object[]}
 */
const buildCourses = () => {
  const categories = ['Core', 'Elective', 'Advanced', 'Professional', 'General', 'Remedial'];

  return Array.from({ length: COUNTS.GLOBAL.courses }, (_, i) => ({
    _id: oid(`course:${pad(i + 1)}`),
    courseCode: `CRS-${pad(i + 1)}`,
    title: `Fixture Course ${i + 1}`,
    category: categories[i % categories.length],
    level: oid(`level:${pad((i % COUNTS.GLOBAL.levels) + 1)}`),
    discipline: 'Fixture Studies',
    description: `Deterministic fixture course ${i + 1}`,
    difficultyLevel: 'INTERMEDIATE',
    approvalStatus: 'APPROVED',
    createdBy: oid('teacher:A:001'),
    visibility: 'INTERNAL',
    status: 'active',
    ...stamps(370),
  }));
};

/**
 * One default grading scale per campus. `isDefault` is unique per campus
 * (`pre('save')` invariant of the model), so exactly one is seeded on each side.
 *
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildGradingScales = (ctx) =>
  CAMPUS_KEYS.map((campusKey, i) => ({
    _id: oid(`grading-scale:${campusKey}`),
    schoolCampus: ctx.campusIds[campusKey],
    name: `Fixture scale ${campusKey}`,
    description: 'Deterministic 0-20 scale',
    system: 'NUMERIC_20',
    maxScore: 20,
    passMark: 10,
    bands: [
      { min: 16, max: 20, label: 'A', description: 'Excellent' },
      { min: 14, max: 15.99, label: 'B', description: 'Good' },
      { min: 10, max: 13.99, label: 'C', description: 'Pass' },
      { min: 0, max: 9.99, label: 'F', description: 'Fail' },
    ],
    isDefault: true,
    isActive: true,
    ...stamps(365 - i),
  }));

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const buildFoundation = (ctx) => {
  const levels = buildLevels();
  const departments = CAMPUS_KEYS.flatMap((key) => buildDepartments(key, ctx));
  const courses = buildCourses();
  const gradingScales = buildGradingScales(ctx);

  return [
    { model: 'Level', docs: levels },
    { model: 'Department', docs: departments },
    { model: 'Course', docs: courses },
    { model: 'GradingScale', docs: gradingScales },
  ];
};

/**
 * Subjects. Campus A carries one subject with `coefficient: 0` — the weighted
 * average has divided by that sum before (§4.3).
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildSubjects = (campusKey, ctx) => {
  const categories = ['Science', 'Mathematics', 'Languages', 'Social Studies', 'Arts', 'Technology'];
  const teachers = ctx.teacherIds[campusKey];

  return Array.from({ length: COUNTS[campusKey].subjects }, (_, i) => ({
    _id: oid(`subject:${campusKey}:${pad(i + 1)}`),
    schoolCampus: ctx.campusIds[campusKey],
    teachers: [teachers[i % teachers.length]],
    department: oid(`department:${campusKey}:${pad((i % COUNTS[campusKey].departments) + 1)}`),
    subject_name: `Subject ${campusKey}${i + 1}`,
    subject_code: `SUB-${campusKey}${pad(i + 1)}`,
    description: `Fixture subject ${campusKey}${i + 1}`,
    coefficient: campusKey === 'A' && i === COUNTS[campusKey].subjects - 1 ? 0 : (i % 4) + 1,
    status: 'active',
    category: categories[i % categories.length],
    courseRef: oid(`course:${pad((i % COUNTS.GLOBAL.courses) + 1)}`),
    ...stamps(360),
  }));
};

/**
 * Classes, including one archived class on campus A. The archived one holds no
 * student: an archived class with a live roster is a different test case, and
 * mixing the two would make a failure ambiguous.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildClasses = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const teachers = ctx.teacherIds[campusKey];
  // `Class` carries a partial unique index on `classManager`: a teacher manages
  // at most one class, platform-wide. Managers are therefore handed out one per
  // class and only among the LIVE teachers — beyond that the field stays null,
  // which the index tolerates by design.
  const liveTeachers = teachers.slice(0, counts.teachers - counts.teachersArchived);

  return Array.from({ length: counts.classes }, (_, i) => {
    const classId = oid(`class:${campusKey}:${pad(i + 1)}`);
    const archived = i >= counts.classes - counts.classesArchived;

    return {
      _id: classId,
      schoolCampus: ctx.campusIds[campusKey],
      level: oid(`level:${pad((i % COUNTS.GLOBAL.levels) + 1)}`),
      className: `Class ${campusKey}${i + 1}`,
      classManager: i < liveTeachers.length ? liveTeachers[i] : null,
      students: ctx.studentsByClass[String(classId)] || [],
      teachers: [teachers[i % teachers.length]],
      status: archived ? 'archived' : 'active',
      maxStudents: 50,
      academicYear: ACADEMIC_YEAR,
      room: `R-${campusKey}${i + 1}`,
      ...stamps(355),
    };
  });
};

/**
 * One teaching week per campus: five live slots plus one retired slot, on both
 * the student-facing and the teacher-facing timetable.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {{ studentSlots: Object[], teacherSlots: Object[] }}
 */
const buildSchedules = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const campusId = ctx.campusIds[campusKey];
  const teacher = ctx.teachers[campusKey][0];
  const total = counts.scheduleSlots + counts.scheduleSlotsDeleted;

  const studentSlots = [];
  const teacherSlots = [];

  for (let i = 0; i < total; i += 1) {
    const deleted = i >= counts.scheduleSlots;
    const day = WEEK_DAYS[i % WEEK_DAYS.length];
    const start = ctx.at(day, i % 3);
    const end = ctx.at(day, (i % 3) + 2);
    const subjectId = oid(`subject:${campusKey}:${pad((i % counts.subjects) + 1)}`);
    const classId = oid(`class:${campusKey}:001`);

    const shared = {
      schoolCampus: campusId,
      academicYear: ACADEMIC_YEAR,
      semester: 'S2',
      sessionType: 'LECTURE',
      startTime: start,
      endTime: end,
      durationMinutes: 120,
      status: deleted ? 'CANCELLED' : 'PUBLISHED',
      isVirtual: false,
      room: { code: `R-${campusKey}${(i % 3) + 1}`, name: `Room ${campusKey}${(i % 3) + 1}`, capacity: 50 },
      ...stamps(30),
    };

    // Retired slots are marked through the helper: `StudentSchedule` and
    // `TeacherSchedule` follow the `isDeleted` convention, and hand-writing it
    // is exactly the silent failure R7 forbids.
    const deletionPatch = deleted ? ctx.softDelete('StudentSchedule', ctx.at(-5)) : {};
    const teacherDeletionPatch = deleted ? ctx.softDelete('TeacherSchedule', ctx.at(-5)) : {};

    studentSlots.push({
      _id: oid(`student-schedule:${campusKey}:${pad(i + 1)}`),
      reference: `SSC-${campusKey}-${pad(i + 1)}`,
      ...shared,
      subject: {
        subjectId,
        subject_name: `Subject ${campusKey}${(i % counts.subjects) + 1}`,
        subject_code: `SUB-${campusKey}${pad((i % counts.subjects) + 1)}`,
        coefficient: 1,
        department: oid(`department:${campusKey}:001`),
      },
      teacher: {
        teacherId: teacher._id,
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: teacher.email,
      },
      // The embedded reference carries its own `_id`: Mongoose would mint a
      // fresh one on every run, and a subdocument id is enough to make two
      // otherwise identical seeds differ.
      classes: [{ _id: oid(`student-schedule-class:${campusKey}:${pad(i + 1)}`), classId, className: `Class ${campusKey}1` }],
      expectedAttendees: 5,
      topic: `Fixture session ${i + 1}`,
      ...deletionPatch,
    });

    teacherSlots.push({
      _id: oid(`teacher-schedule:${campusKey}:${pad(i + 1)}`),
      reference: `TSC-${campusKey}-${pad(i + 1)}`,
      studentScheduleRef: oid(`student-schedule:${campusKey}:${pad(i + 1)}`),
      ...shared,
      teacher: {
        teacherId: teacher._id,
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: teacher.email,
        matricule: teacher.matricule,
      },
      subject: {
        subjectId,
        subject_name: `Subject ${campusKey}${(i % counts.subjects) + 1}`,
        subject_code: `SUB-${campusKey}${pad((i % counts.subjects) + 1)}`,
        department: oid(`department:${campusKey}:001`),
      },
      classes: [{ _id: oid(`teacher-schedule-class:${campusKey}:${pad(i + 1)}`), classId, className: `Class ${campusKey}1` }],
      ...teacherDeletionPatch,
    });
  }

  return { studentSlots, teacherSlots };
};

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const buildTeaching = (ctx) => {
  const subjects = CAMPUS_KEYS.flatMap((key) => buildSubjects(key, ctx));
  const classes = CAMPUS_KEYS.flatMap((key) => buildClasses(key, ctx));
  const schedules = CAMPUS_KEYS.map((key) => buildSchedules(key, ctx));

  return [
    { model: 'Subject', docs: subjects },
    { model: 'Class', docs: classes },
    { model: 'StudentSchedule', docs: schedules.flatMap((s) => s.studentSlots) },
    { model: 'TeacherSchedule', docs: schedules.flatMap((s) => s.teacherSlots) },
  ];
};

module.exports = { buildFoundation, buildTeaching };
