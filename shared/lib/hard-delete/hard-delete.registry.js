'use strict';

/**
 * @file hard-delete.registry.js
 * @description Declarative catalogue of every entity that may be permanently deleted.
 *
 * A hard delete is irreversible, so the decision of *what* it touches must not live inside a
 * controller where it can drift. Each entry below states, in one place:
 *
 *   - who may run it (`roles`) and how the target is identified to the operator,
 *   - whether the entity must already be soft-deleted (`requireArchivedFirst`),
 *   - and, for every related collection, whether it BLOCKS the deletion, is CASCADE-deleted
 *     inside the same transaction, or is simply DETACHed.
 *
 * Policy behind the three modes (CLAUDE.md §5.2):
 *
 *   BLOCK   — official academic or financial records. A student with a published result or a
 *             recorded payment is not a mistake to erase; the operator must archive instead.
 *             Blocking is what keeps a single wrong click from destroying a transcript.
 *   CASCADE — derived, operational rows that mean nothing once their owner is gone
 *             (attendance lines, notifications, preferences, activation tokens).
 *   DETACH  — soft links held by *other* documents. The related document survives with its
 *             reference removed, so no dangling id is ever left behind.
 *
 * Models are loaded lazily (`() => require(...)`) so this registry can be required from
 * anywhere — including `app.js` — without creating a module cycle.
 *
 * An entity that is NOT in this registry cannot be hard-deleted. That is the intended
 * default: the danger zone is an allowlist, never a fallback.
 */

const { RELATION_MODE } = require('./hard-delete.constants');

// ── Lazy model accessors ──────────────────────────────────────────────────────

const M = {
  Student:           () => require('../../../modules/student/models/student.model'),
  StudentAttendance: () => require('../../../modules/student/models/student.attend.model'),
  StudentSchedule:   () => require('../../../modules/student/models/student.schedule.model'),
  Teacher:           () => require('../../../modules/teacher/models/teacher.model'),
  TeacherAttendance: () => require('../../../modules/teacher/models/teacher.attend.model'),
  TeacherSchedule:   () => require('../../../modules/teacher/models/teacher.schedule.model'),
  Parent:            () => require('../../../modules/parent/parent.model'),
  Mentor:            () => require('../../../modules/mentor/mentor.model'),
  Staff:             () => require('../../../modules/staff/models/staff.model'),
  StaffRole:         () => require('../../../modules/staff/models/staffRole.model'),
  Class:             () => require('../../../modules/class/class.model'),
  Level:             () => require('../../../modules/level/level.model'),
  Subject:           () => require('../../../modules/subject/subject.model'),
  Department:        () => require('../../../modules/department/department.model'),
  // Named exports: these modules export an object of { Model, ...enums }.
  Course:            () => require('../../../modules/course/course.model').Course,
  Campus:            () => require('../../../modules/campus/campus.model'),
  Partner:           () => require('../../../modules/partner/models/partner.model'),
  PartnerLead:       () => require('../../../modules/partner/models/partner.lead.model'),
  PartnerCommission: () => require('../../../modules/partner/models/partner.commission.model'),
  Announcement:      () => require('../../../modules/announcement/models/announcement.model'),
  UserNotification:  () => require('../../../modules/announcement/models/user-notification.model'),
  Notification:      () => require('../../../modules/notification/models/notification.model'),
  UserPreferences:   () => require('../../../modules/settings/models/userPreferences.model'),
  ActivationToken:   () => require('../../../modules/account/account.activation.model'),
  Result:            () => require('../../../modules/result/models/result.model').Result,
  FinalTranscript:   () => require('../../../modules/result/models/final-transcript.model').FinalTranscript,
  Document:          () => require('../../../modules/document/models/document.model'),
  DocumentAudit:     () => require('../../../modules/document/models/document.audit.model'),
  DocumentShare:     () => require('../../../modules/document/models/document.share.model'),
  DocumentTemplate:  () => require('../../../modules/document/models/document.template.model'),
  DocumentVersion:   () => require('../../../modules/document/models/document.version.model'),
  StudentFee:        () => require('../../../modules/finance/models/studentFee.model'),
  FeePayment:        () => require('../../../modules/finance/models/feePayment.model'),
  Income:            () => require('../../../modules/finance/models/income.model'),
  Expense:           () => require('../../../modules/finance/models/expense.model'),
  ExamSession:       () => require('../../../modules/exam/models/exam.session.model'),
  ExamEnrollment:    () => require('../../../modules/exam/models/exam.enrollment.model'),
  ExamSubmission:    () => require('../../../modules/exam/models/exam.submission.model'),
  ExamGrading:       () => require('../../../modules/exam/models/exam.grading.model'),
  ExamAppeal:        () => require('../../../modules/exam/models/exam.appeal.model'),
  ExamAnalyticsSnapshot: () => require('../../../modules/exam/models/exam.analytics-snapshot.model'),
  QuestionBank:      () => require('../../../modules/exam/models/question-bank.model'),
  GradingScale:      () => require('../../../modules/result/models/grading-scale.model').GradingScale,
  GaetConstraint:    () => require('../../../modules/gaet/gaet-constraint.model'),
  PartnerApplication:() => require('../../../modules/partner/models/partner.application.model'),
  PrintJob:          () => require('../../../modules/academic-print/models/print-job.model'),
  CompetitionPrize:  () => require('../../../modules/public-portal/models/competition.prize.model'),
  ContactMessage:    () => require('../../../modules/public-portal/models/contact.message.model'),
  CoursePreview:     () => require('../../../modules/public-portal/models/course.preview.model'),
  FaqEntry:          () => require('../../../modules/public-portal/models/faq.entry.model'),
  QuizQuestion:      () => require('../../../modules/public-portal/models/quiz.question.model'),
  QuizSession:       () => require('../../../modules/public-portal/models/quiz.session.model'),
  Testimonial:       () => require('../../../modules/public-portal/models/testimonial.model'),
  DeletionAudit:     () => require('./deletion-audit.model'),
};

// ── Relation builders ─────────────────────────────────────────────────────────

/**
 * Declares a relation that forbids the deletion while it matches at least one document.
 *
 * @param {string}   model  - Key in {@link M}.
 * @param {string}   label  - Human-readable label surfaced in the impact report.
 * @param {Function} filter - `(id) => mongoFilter`
 */
const block = (model, label, filter) => ({ model, label, filter, mode: RELATION_MODE.BLOCK });

/**
 * Declares a relation whose documents are hard-deleted in the same transaction.
 *
 * @param {string}   model
 * @param {string}   label
 * @param {Function} filter - `(id) => mongoFilter`
 */
const cascade = (model, label, filter) => ({ model, label, filter, mode: RELATION_MODE.CASCADE });

/**
 * Declares a relation whose documents survive with the reference removed.
 *
 * @param {string}   model
 * @param {string}   label
 * @param {Function} filter - `(id) => mongoFilter`
 * @param {Function} update - `(id) => mongoUpdate`, e.g. `$pull` or `$unset`
 */
const detach = (model, label, filter, update) =>
  ({ model, label, filter, update, mode: RELATION_MODE.DETACH });

/**
 * Declares a reference that is deliberately LEFT pointing at the removed id.
 *
 * Reserved for historical provenance stored in a **required** field — "who recorded this
 * attendance line", "who published this schedule". Detaching would leave a surviving document
 * in breach of its own schema (`updateMany` runs no validators, so the breach only surfaces
 * later, on an unrelated `save()`); blocking would make any actor who ever touched a record
 * permanently undeletable.
 *
 * The reference is counted and surfaced in the impact report so the operator approves it
 * knowingly. This is the declared form of the case that would otherwise be the silent default.
 *
 * @param {string}   model
 * @param {string}   label
 * @param {Function} filter - `(id) => mongoFilter`
 */
const retain = (model, label, filter) => ({ model, label, filter, mode: RELATION_MODE.RETAIN });

/**
 * The account-scoped rows every human actor carries. Identical for students, teachers,
 * parents, mentors and staff — factored out so a new actor type cannot forget one.
 *
 * @param {string} userModel - Value stored in `recipientModel` / `userModel` discriminators.
 * @returns {Array<Object>} Relation declarations.
 */
const accountSideCars = (userModel) => [
  cascade('Notification',     'Notification history',  (id) => ({ recipientId: id, recipientModel: userModel })),
  cascade('UserNotification', 'Announcement read receipts', (id) => ({ userId: id })),
  cascade('UserPreferences',  'User preferences',      (id) => ({ userId: id, userModel })),
  cascade('ActivationToken',  'Pending activation tokens', (id) => ({ userId: id, userModel })),
];

/** Credential and token fields stripped from every audit snapshot. */
const ACCOUNT_SECRETS = Object.freeze([
  'password', 'passwordResetToken', 'passwordResetExpires',
  'tokenHash', 'codeHash', 'verificationToken', '__v',
]);

const fullName = (doc) => `${doc.firstName ?? ''} ${doc.lastName ?? ''}`.trim();

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} HardDeleteEntry
 * @property {string}   label                 Entity name shown to the operator.
 * @property {Function} model                 Lazy Mongoose model accessor.
 * @property {string[]} roles                 Roles allowed to run this deletion.
 * @property {string|null} campusPath         Path holding the campus ref; null when global.
 * @property {Function} identifier            `(doc) => string` — the business key to type.
 * @property {Function} display               `(doc) => string` — the human label.
 * @property {boolean}  requireArchivedFirst  Refuse unless the entity is already soft-deleted.
 * @property {string[]} [redact]              Fields stripped from the audit snapshot.
 * @property {Function} [files]               `(doc) => [{ folder, path }]` stored files to remove.
 * @property {Array}    relations             Relation declarations (block / cascade / detach).
 * @property {string}   [customExecutor]      Delegate execution to a module service instead.
 */

/** @type {Record<string, HardDeleteEntry>} */
const REGISTRY = Object.freeze({

  // ── Actors ──────────────────────────────────────────────────────────────────

  student: {
    label: 'Student',
    model: M.Student,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.matricule || doc.username,
    display: fullName,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    files: (doc) => [{ folder: 'students', path: doc.profileImage }],
    relations: [
      // Academic and financial record — never destroyed by an operator action.
      block('Result',          'Academic results',          (id) => ({ student: id })),
      block('FinalTranscript', 'Final transcripts',         (id) => ({ student: id })),
      block('ExamGrading',     'Exam gradings',             (id) => ({ student: id })),
      block('FeePayment',      'Recorded fee payments',     (id) => ({ student: id })),
      block('Income',          'Recorded income entries',   (id) => ({ student: id })),
      block('Document',        'Live GED documents',        (id) => ({ 'metadata.studentId': id, deletedAt: null })),

      // Operational rows — meaningless once the student is gone.
      cascade('StudentAttendance', 'Attendance records',    (id) => ({ student: id })),
      cascade('ExamEnrollment',    'Exam enrollments',      (id) => ({ student: id })),
      cascade('ExamSubmission',    'Exam submissions',      (id) => ({ student: id })),
      cascade('ExamAppeal',        'Exam appeals',          (id) => ({ student: id })),
      cascade('StudentFee',        'Fee lines (unpaid)',    (id) => ({ student: id })),
      ...accountSideCars('Student'),

      // Back-references held by other documents.
      detach('Class',  'Class rosters',  (id) => ({ students: id }), (id) => ({ $pull: { students: id } })),
      detach('Parent', 'Parent records', (id) => ({ children: id }), (id) => ({ $pull: { children: id } })),
    ],
  },

  teacher: {
    label: 'Teacher',
    model: M.Teacher,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.matricule || doc.username,
    display: fullName,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    files: (doc) => [{ folder: 'teachers', path: doc.profileImage }],
    relations: [
      block('Result',            'Results they graded',      (id) => ({ teacher: id })),
      block('ExamGrading',       'Exam gradings they signed',(id) => ({ grader: id })),
      block('ExamGrading',       'Exam gradings they countersigned', (id) => ({ secondGrader: id })),
      block('TeacherAttendance', 'Paid attendance records',  (id) => ({ teacher: id, isPaid: true })),
      block('Document',          'Live GED documents',       (id) => ({ 'metadata.teacherId': id, deletedAt: null })),
      block('TeacherSchedule',   'Live teaching schedule',   (id) => ({ 'teacher.teacherId': id, isDeleted: false })),
      // Both schedule models declare `teacher.teacherId` as REQUIRED, so the reference cannot
      // be unset and the row cannot be left dangling: the operator must retire the sessions
      // first. ExamSession.teacher is required for the same reason.
      block('StudentSchedule',   'Live student timetable slots', (id) => ({ 'teacher.teacherId': id, isDeleted: false })),
      block('ExamSession',       'Exam sessions they own',   (id) => ({ teacher: id, isDeleted: false })),

      cascade('TeacherAttendance', 'Unpaid attendance records', (id) => ({ teacher: id })),
      // Already soft-deleted schedule rows carry no operational value and would otherwise
      // survive the BLOCK above as dangling required references.
      cascade('TeacherSchedule',   'Retired teaching schedule', (id) => ({ 'teacher.teacherId': id, isDeleted: true })),
      cascade('StudentSchedule',   'Retired timetable slots',   (id) => ({ 'teacher.teacherId': id, isDeleted: true })),
      ...accountSideCars('Teacher'),

      detach('Class',       'Classes they manage',    (id) => ({ classManager: id }), () => ({ $unset: { classManager: '' } })),
      detach('Class',       'Class teaching staff',   (id) => ({ teachers: id }),     (id) => ({ $pull: { teachers: id } })),
      detach('Subject',     'Subject teaching staff', (id) => ({ teachers: id }),     (id) => ({ $pull: { teachers: id } })),
      detach('Department',  'Department headship',    (id) => ({ headOfDepartment: id }), () => ({ $unset: { headOfDepartment: '' } })),
      detach('ExamSession', 'Invigilation duties',    (id) => ({ invigilators: id }), (id) => ({ $pull: { invigilators: id } })),
      detach('Course',      'Courses they authored',  (id) => ({ createdBy: id }),    () => ({ $unset: { createdBy: '' } })),
      detach('ExamEnrollment', 'Exam check-ins they performed', (id) => ({ checkedInBy: id }), () => ({ $unset: { checkedInBy: '' } })),

      // Provenance on records that outlive the teacher. `recordedBy` is required on both
      // attendance models and `Result.classManager` is the signatory of a published result:
      // unsetting either would corrupt a surviving academic record.
      retain('StudentAttendance', 'Attendance lines they recorded', (id) => ({
        $or: [{ recordedBy: id }, { justifiedBy: id }, { lastModifiedBy: id }],
      })),
      retain('TeacherAttendance', 'Attendance lines they recorded or replaced', (id) => ({
        $or: [{ recordedBy: id }, { justifiedBy: id }, { lastModifiedBy: id }, { replacementTeacher: id }],
      })),
      retain('Result', 'Results they countersigned as class manager', (id) => ({ classManager: id })),
      retain('StudentSchedule', 'Timetable slots they published or edited', (id) => ({
        $or: [{ publishedBy: id }, { lastModifiedBy: id }, { deletedBy: id }],
      })),
      retain('TeacherSchedule', 'Schedules they published or edited', (id) => ({
        $or: [{ publishedBy: id }, { lastModifiedBy: id }, { deletedBy: id }],
      })),
    ],
  },

  parent: {
    label: 'Parent',
    model: M.Parent,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.username || doc.email,
    display: fullName,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    files: (doc) => [{ folder: 'parents', path: doc.profileImage }],
    relations: [
      ...accountSideCars('Parent'),
    ],
  },

  mentor: {
    label: 'Mentor',
    model: M.Mentor,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.username || doc.email,
    display: fullName,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    files: (doc) => [{ folder: 'mentors', path: doc.profileImage }],
    relations: [
      ...accountSideCars('Mentor'),
      // Student.mentor is the single source of truth for the assignment
      // (project_mentor_assignment) — unsetting it is the whole cleanup.
      detach('Student', 'Mentored students', (id) => ({ mentor: id }), () => ({ $unset: { mentor: '' } })),
    ],
  },

  staff: {
    label: 'Staff member',
    model: M.Staff,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.username || doc.email,
    display: fullName,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    files: (doc) => [{ folder: 'staff', path: doc.profileImage }],
    relations: [
      ...accountSideCars('Staff'),
      detach('GaetConstraint', 'Timetable authorship', (id) => ({ generatedBy: id }), () => ({ $unset: { generatedBy: '' } })),
      detach('GaetConstraint', 'Timetable publication', (id) => ({ publishedBy: id }), () => ({ $unset: { publishedBy: '' } })),
      detach('PartnerApplication', 'Partner applications they reviewed', (id) => ({ reviewedBy: id }), () => ({ $unset: { reviewedBy: '' } })),
    ],
  },

  // ── Configuration ───────────────────────────────────────────────────────────

  'staff-role': {
    label: 'Staff role',
    model: M.StaffRole,
    // The only entry open to a CAMPUS_MANAGER: roles are campus-scoped configuration they
    // create themselves. buildScopeFilter() pins them to their own campus.
    roles: ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'],
    campusPath: 'campus',
    identifier: (doc) => doc.name,
    display: (doc) => doc.name,
    requireArchivedFirst: false, // StaffRole has no soft-delete marker (CLAUDE.md §5.1)
    relations: [
      block('Staff', 'Staff members holding this role', (id) => ({ subRole: id })),
    ],
  },

  class: {
    label: 'Class',
    model: M.Class,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.className,
    display: (doc) => doc.className,
    requireArchivedFirst: true,
    relations: [
      block('Student',         'Enrolled students', (id) => ({ studentClass: id })),
      block('Result',          'Results',           (id) => ({ class: id })),
      block('FinalTranscript', 'Final transcripts', (id) => ({ class: id })),
      block('ExamSession',     'Exam sessions',     (id) => ({ classes: id })),
      // `class` is REQUIRED on both attendance models: a surviving attendance line cannot be
      // detached from its class, and the history of students who have since moved on must not
      // be destroyed to make a configuration row disappear.
      block('StudentAttendance', 'Student attendance history', (id) => ({ class: id })),
      block('TeacherAttendance', 'Teacher attendance history', (id) => ({ class: id })),
      block('Income',            'Recorded income entries',    (id) => ({ class: id })),
      block('Document',          'Live GED documents',         (id) => ({ 'metadata.classId': id, deletedAt: null })),

      detach('Teacher', 'Teacher assignments', (id) => ({ classes: id }), (id) => ({ $pull: { classes: id } })),
      detach('Mentor',  'Mentor assignments',  (id) => ({ classes: id }), (id) => ({ $pull: { classes: id } })),
    ],
  },

  subject: {
    label: 'Subject',
    model: M.Subject,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.subject_code,
    display: (doc) => doc.subject_name,
    requireArchivedFirst: true,
    relations: [
      block('Result',       'Results',        (id) => ({ subject: id })),
      block('ExamSession',  'Exam sessions',  (id) => ({ subject: id })),
      block('QuestionBank', 'Question bank',  (id) => ({ subject: id })),
      // `subject` is REQUIRED on both attendance models and on StudentSchedule.
      block('StudentAttendance', 'Student attendance history',   (id) => ({ subject: id })),
      block('TeacherAttendance', 'Teacher attendance history',   (id) => ({ subject: id })),
      block('StudentSchedule',   'Live student timetable slots', (id) => ({ 'subject.subjectId': id, isDeleted: false })),
      block('TeacherSchedule',   'Live teaching schedule',       (id) => ({ 'subject.subjectId': id, isDeleted: false })),

      cascade('StudentSchedule', 'Retired timetable slots',   (id) => ({ 'subject.subjectId': id, isDeleted: true })),
      cascade('TeacherSchedule', 'Retired teaching schedule', (id) => ({ 'subject.subjectId': id, isDeleted: true })),

      detach('Teacher', 'Teacher assignments', (id) => ({ subjects: id }), (id) => ({ $pull: { subjects: id } })),
    ],
  },

  department: {
    label: 'Department',
    model: M.Department,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.code,
    display: (doc) => doc.name,
    requireArchivedFirst: true,
    relations: [
      block('Teacher', 'Teachers in this department', (id) => ({ department: id })),
      block('Subject', 'Subjects in this department', (id) => ({ department: id })),

      // Schedules embed a denormalised copy of the subject, department included. The field is
      // optional and purely descriptive, so the surviving slot keeps it as written history.
      retain('StudentSchedule', 'Timetable slots citing this department', (id) => ({ 'subject.department': id })),
      retain('TeacherSchedule', 'Schedules citing this department',       (id) => ({ 'subject.department': id })),
    ],
  },

  level: {
    label: 'Level',
    model: M.Level,
    roles: ['ADMIN'],
    campusPath: null, // global collection (CLAUDE.md §5)
    identifier: (doc) => doc.code,
    display: (doc) => doc.name,
    requireArchivedFirst: true,
    relations: [
      block('Class',  'Classes on this level', (id) => ({ level: id })),
      block('Course', 'Courses on this level', (id) => ({ level: id })),
    ],
  },

  course: {
    label: 'Course',
    model: M.Course,
    roles: ['ADMIN'],
    campusPath: null, // global collection (CLAUDE.md §5)
    identifier: (doc) => doc.courseCode,
    display: (doc) => doc.title,
    requireArchivedFirst: true,
    relations: [
      block('Subject',      'Subjects built on this course', (id) => ({ courseRef: id })),
      block('QuestionBank', 'Question bank',                 (id) => ({ course: id })),
      block('ExamSession',  'Exam prerequisites',            (id) => ({ 'eligibilityRules.prerequisiteCourses': id })),
      block('Course',       'Derived course versions',       (id) => ({ parentCourseId: id })),
      block('Income',       'Recorded income entries',       (id) => ({ course: id })),
      block('Document',     'Live GED documents',            (id) => ({ 'metadata.courseId': id, deletedAt: null })),
    ],
  },

  partner: {
    label: 'Partner',
    model: M.Partner,
    roles: ['ADMIN'],
    campusPath: 'schoolCampus',
    identifier: (doc) => doc.username || doc.email,
    display: (doc) => doc.companyName || fullName(doc),
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    relations: [
      block('PartnerCommission', 'Commissions',   (id) => ({ partner: id })),
      block('PartnerLead',       'Referred leads',(id) => ({ partner: id })),
      ...accountSideCars('Partner'),
      // The application that produced this partner survives as recruitment history, with its
      // pointer cleared — the field is optional and carries no accounting value.
      detach('PartnerApplication', 'Originating application', (id) => ({ partnerId: id }), () => ({ $unset: { partnerId: '' } })),
    ],
  },

  announcement: {
    label: 'Announcement',
    model: M.Announcement,
    roles: ['ADMIN', 'DIRECTOR'],
    campusPath: 'schoolCampus',
    identifier: (doc) => String(doc._id),
    display: (doc) => doc.title,
    requireArchivedFirst: true,
    relations: [
      cascade('UserNotification', 'Read receipts', (id) => ({ announcement: id })),
    ],
  },

  campus: {
    label: 'Campus',
    model: M.Campus,
    roles: ['ADMIN'],
    campusPath: '_id',
    identifier: (doc) => doc.campusSlug || doc.name,
    display: (doc) => doc.name,
    requireArchivedFirst: true,
    redact: ACCOUNT_SECRETS,
    relations: [
      // A campus is the tenant boundary itself: EVERY campus-scoped collection has to be
      // accounted for here, or deleting a campus silently strands a whole tenant's rows with
      // a `schoolCampus` pointing at nothing. `tests/unit/hard-delete.test.js` pins that list
      // against the real schemas, so a new campus-scoped model fails the suite until it is
      // declared below.

      // ── Business record: must be empty before the tenant can go ──────────────
      block('Student',    'Students',    (id) => ({ schoolCampus: id })),
      block('Teacher',    'Teachers',    (id) => ({ schoolCampus: id })),
      block('Staff',      'Staff',       (id) => ({ schoolCampus: id })),
      block('Parent',     'Parents',     (id) => ({ schoolCampus: id })),
      block('Mentor',     'Mentors',     (id) => ({ schoolCampus: id })),
      block('Class',      'Classes',     (id) => ({ schoolCampus: id })),
      block('Subject',    'Subjects',    (id) => ({ schoolCampus: id })),
      block('Department', 'Departments', (id) => ({ schoolCampus: id })),
      block('StaffRole',  'Staff roles', (id) => ({ campus: id })),
      block('Result',          'Results',           (id) => ({ schoolCampus: id })),
      block('FinalTranscript', 'Final transcripts', (id) => ({ schoolCampus: id })),
      block('GradingScale',    'Grading scales',    (id) => ({ schoolCampus: id })),
      block('Document',        'GED documents',     (id) => ({ campusId: id })),
      block('Announcement',    'Announcements',     (id) => ({ schoolCampus: id })),
      block('Partner',            'Partners',              (id) => ({ schoolCampus: id })),
      block('PartnerLead',        'Referred leads',        (id) => ({ schoolCampus: id })),
      block('PartnerCommission',  'Partner commissions',   (id) => ({ schoolCampus: id })),
      block('PartnerApplication', 'Partner applications',  (id) => ({ schoolCampus: id })),
      block('StudentFee', 'Student fee lines',   (id) => ({ schoolCampus: id })),
      block('FeePayment', 'Recorded payments',   (id) => ({ schoolCampus: id })),
      block('Income',     'Income entries',      (id) => ({ schoolCampus: id })),
      block('Expense',    'Expense entries',     (id) => ({ schoolCampus: id })),
      block('ExamSession',    'Exam sessions',    (id) => ({ schoolCampus: id })),
      block('ExamEnrollment', 'Exam enrollments', (id) => ({ schoolCampus: id })),
      block('ExamSubmission', 'Exam submissions', (id) => ({ schoolCampus: id })),
      block('ExamGrading',    'Exam gradings',    (id) => ({ schoolCampus: id })),
      block('ExamAppeal',     'Exam appeals',     (id) => ({ schoolCampus: id })),
      block('QuestionBank',   'Question bank',    (id) => ({ schoolCampus: id })),
      block('StudentAttendance', 'Student attendance history', (id) => ({ schoolCampus: id })),
      block('TeacherAttendance', 'Teacher attendance history', (id) => ({ schoolCampus: id })),
      block('StudentSchedule',   'Student timetables',         (id) => ({ schoolCampus: id })),
      block('TeacherSchedule',   'Teaching schedules',         (id) => ({ schoolCampus: id })),

      // ── Operational and marketing rows owned by the tenant ───────────────────
      // Nothing here outlives the campus: they are either derived from rows the BLOCKs above
      // already force to zero, or campus-local content with no cross-tenant meaning.
      cascade('Notification',     'Notification history',        (id) => ({ schoolCampus: id })),
      cascade('UserNotification', 'Announcement read receipts',  (id) => ({ schoolCampus: id })),
      cascade('UserPreferences',  'User preferences',            (id) => ({ campusId: id })),
      cascade('ActivationToken',  'Pending activation tokens',   (id) => ({ campusId: id })),
      cascade('PrintJob',         'Print queue',                 (id) => ({ campusId: id })),
      cascade('GaetConstraint',   'Timetable generation runs',   (id) => ({ schoolCampus: id })),
      cascade('ExamAnalyticsSnapshot', 'Exam analytics snapshots', (id) => ({ schoolCampus: id })),
      cascade('DocumentTemplate', 'GED templates',               (id) => ({ campusId: id })),
      cascade('DocumentVersion',  'GED document versions',       (id) => ({ campusId: id })),
      cascade('DocumentShare',    'GED share links',             (id) => ({ campusId: id })),
      cascade('QuizSession',      'Portal quiz sessions',        (id) => ({ schoolCampus: id })),
      cascade('QuizQuestion',     'Portal quiz questions',       (id) => ({ schoolCampus: id })),
      cascade('Testimonial',      'Portal testimonials',         (id) => ({ schoolCampus: id })),
      cascade('FaqEntry',         'Portal FAQ entries',          (id) => ({ schoolCampus: id })),
      cascade('CoursePreview',    'Portal course previews',      (id) => ({ schoolCampus: id })),
      cascade('CompetitionPrize', 'Portal competitions',         (id) => ({ schoolCampus: id })),
      cascade('ContactMessage',   'Portal contact messages',     (id) => ({ schoolCampus: id })),

      // ── Ledgers: they exist precisely to outlive what they describe ──────────
      // Both refuse deleteMany() at the schema level, so CASCADE here would abort the whole
      // transaction. Their campusId is expected to point at a removed campus.
      retain('DocumentAudit', 'GED audit trail (kept)',      (id) => ({ campusId: id })),
      retain('DeletionAudit', 'Deletion ledger (kept)',      (id) => ({ campusId: id })),
    ],
  },

  // ── Records ─────────────────────────────────────────────────────────────────

  document: {
    label: 'Document',
    model: M.Document,
    roles: ['ADMIN', 'DIRECTOR'],
    campusPath: 'campusId',
    identifier: (doc) => doc.reference || String(doc._id),
    display: (doc) => doc.title,
    requireArchivedFirst: true,
    /**
     * BLOCK and RETAIN only — see `customExecutor` below. The version and share purges live in
     * document.service.hardDeleteDocument, inside its own transaction; declaring them as
     * CASCADE here would read as a promise the generic executor never keeps.
     */
    relations: [
      retain('DocumentAudit', 'GED audit trail (kept)', (id) => ({ documentId: id })),
    ],
    /**
     * References the module's own teardown removes, declared here so the reference-coverage
     * test can tell "handled elsewhere" from "forgotten". Both are purged inside
     * document.service.hardDeleteDocument's transaction.
     */
    handledByExecutor: ['DocumentVersion.documentId', 'DocumentShare.documentId'],
    /**
     * The GED owns a richer teardown than the generic executor can express: version purge,
     * share-link purge, storage-cache invalidation, DocumentAudit entry and an ai-service
     * re-ingest signal. The gate (ticket, phrase, password, reason, audit) still runs here;
     * only the removal itself is delegated. See document.service.hardDeleteDocument.
     *
     * Because that path replaces `runTransactionalDelete()` wholesale, a CASCADE or DETACH
     * declared on this entry would be counted in the impact report and then never applied.
     * The registry test refuses that combination outright.
     */
    customExecutor: 'document',
  },
});

/**
 * Resolves a registry entry by key.
 *
 * @param {string} entityType
 * @returns {HardDeleteEntry|null} `null` when the entity is not hard-deletable.
 */
const getEntry = (entityType) =>
  Object.prototype.hasOwnProperty.call(REGISTRY, entityType) ? REGISTRY[entityType] : null;

/**
 * Lists every hard-deletable entity type visible to a role — the payload behind the
 * frontend's danger-zone entity picker.
 *
 * @param {string} role
 * @returns {Array<{ key: string, label: string, requireArchivedFirst: boolean }>}
 */
const listEntries = (role) =>
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.roles.includes(role))
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      requireArchivedFirst: entry.requireArchivedFirst,
    }));

/**
 * Resolves the lazy model accessor of a relation declaration.
 *
 * @param {{ model: string }} relation
 * @returns {import('mongoose').Model}
 * @throws {Error} When the relation names a model missing from the accessor table.
 */
const resolveRelationModel = (relation) => {
  const loader = M[relation.model];
  if (!loader) {
    throw new Error(`hard-delete registry: unknown related model '${relation.model}'`);
  }
  return loader();
};

module.exports = {
  REGISTRY,
  getEntry,
  listEntries,
  resolveRelationModel,
  MODEL_ACCESSORS: M,
};
