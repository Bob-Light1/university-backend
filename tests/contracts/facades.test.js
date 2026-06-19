'use strict';

/**
 * CONTRACT tests for module facades.
 *
 * Guarantees the modular monolith invariant (MODULAR_MONOLITH_MIGRATION.md §3):
 * each module exposes exactly `{ routes, service }` via its index.js, and the
 * service functions consumed by OTHER modules (the inter-module API built
 * during work item 20b waves B/C) remain present.
 *
 * This test would have caught a missing or renamed facade export — the most
 * likely class of regression after the migration.
 */

const MODULES = [
  'academic-print', 'admin', 'announcement', 'campus', 'class', 'course',
  'department', 'document', 'exam', 'finance', 'gaet', 'level', 'mentor',
  'notification', 'parent', 'partner', 'public-portal', 'result', 'settings',
  'staff', 'student', 'subject', 'teacher',
];

describe('Forme de façade { routes, service } pour chaque module', () => {
  test.each(MODULES)('modules/%s expose routes + service', (name) => {
    const mod = require(`../../modules/${name}`);
    expect(mod).toHaveProperty('routes');        // may be null (e.g. finance)
    expect(mod).toHaveProperty('service');
    expect(typeof mod.service).toBe('object');
    expect(mod.service).not.toBeNull();
  });
});

describe('API inter-modules — fonctions de service attendues', () => {
  // [module, [functions exposed and consumed elsewhere]]
  const CONTRACTS = [
    ['campus',  ['getCampusName', 'getCampusDefaults', 'getCampusNotificationContact', 'getCampusDocById', 'getActiveCampusBySlug', 'listActivePublicCampuses']],
    ['class',   ['countClassesOnCampus', 'resolveClassesForSchedule', 'getClassCampusRef', 'findClassForBulk', 'addTeacherToClasses', 'setClassManager']],
    ['subject', ['countSubjectsOnCampus', 'listCampusSubjects', 'getSubjectCampusRef', 'resolveSubjectForSchedule']],
    ['teacher', ['validateTeacherBelongsToCampus', 'countTeachersOnCampus', 'resolveTeacherForSchedule', 'syncTeacherScheduleMirror', 'detectTeacherConflicts']],
    ['student', ['validateStudentBelongsToCampus', 'countStudents', 'listStudentIds', 'resolveSessionParticipants', 'syncTeacherSchedule', 'summarizeStudentAttendance', 'getStudentContact', 'getStudentContacts']],
    ['result',  ['countPublishedResults', 'listCampusResults', 'getRecentResultsForStudent']],
    ['department', ['getDepartmentCampusRef', 'findDepartmentForBulk', 'listDepartmentsForCampus']],
    ['settings', ['getLoginPrefs', 'getPreferredLanguage', 'getPreferredLanguages']],
    ['course',  ['listApprovedCourses', 'isTeacherOfAnyCourse', 'getApprovedCourseForLinking']],
    ['partner', ['findActivePartnerByCode', 'upsertPreRegistrationLead', 'getLeadContact', 'createApplication']],
    ['exam',    ['getUpcomingExamsForStudent', 'listCampusExaminations', 'countPendingGrading']],
    ['document', ['runRetentionJob', 'generateQrCodeDataUrl', 'listPublishedForCampus']],
    ['parent',  ['removeChildFromAllParents']],
    ['notification', ['notify', 'runRetryJob', 'getInbox', 'getUnreadCount', 'markRead', 'markAllRead']],
  ];

  describe.each(CONTRACTS)('modules/%s.service', (name, fns) => {
    const service = require(`../../modules/${name}`).service;
    test.each(fns)('expose %s()', (fn) => {
      expect(typeof service[fn]).toBe('function');
    });
  });

  test('settings.service expose la constante SUPPORTED_TIMEZONES', () => {
    const { SUPPORTED_TIMEZONES } = require('../../modules/settings').service;
    expect(SUPPORTED_TIMEZONES).toBeDefined();
  });
});
