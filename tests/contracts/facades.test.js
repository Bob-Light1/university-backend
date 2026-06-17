'use strict';

/**
 * Tests de CONTRAT des façades de modules.
 *
 * Garantit l'invariant du monolithe modulaire (MODULAR_MONOLITH_MIGRATION.md §3) :
 * chaque module expose exactement `{ routes, service }` via son index.js, et les
 * fonctions de service consommées par d'AUTRES modules (l'API inter-modules
 * construite pendant le chantier 20b vagues B/C) restent présentes.
 *
 * Ce test aurait attrapé un export de façade manquant ou renommé — la classe de
 * régression la plus probable après la migration.
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
    expect(mod).toHaveProperty('routes');        // peut être null (ex. finance)
    expect(mod).toHaveProperty('service');
    expect(typeof mod.service).toBe('object');
    expect(mod.service).not.toBeNull();
  });
});

describe('API inter-modules — fonctions de service attendues', () => {
  // [module, [fonctions exposées et consommées ailleurs]]
  const CONTRACTS = [
    ['campus',  ['getCampusName', 'getCampusDefaults', 'getCampusDocById', 'getActiveCampusBySlug', 'listActivePublicCampuses']],
    ['class',   ['countClassesOnCampus', 'resolveClassesForSchedule', 'getClassCampusRef', 'findClassForBulk', 'addTeacherToClasses', 'setClassManager']],
    ['subject', ['countSubjectsOnCampus', 'listCampusSubjects', 'getSubjectCampusRef', 'resolveSubjectForSchedule']],
    ['teacher', ['validateTeacherBelongsToCampus', 'countTeachersOnCampus', 'resolveTeacherForSchedule', 'syncTeacherScheduleMirror', 'detectTeacherConflicts']],
    ['student', ['validateStudentBelongsToCampus', 'countStudents', 'listStudentIds', 'resolveSessionParticipants', 'syncTeacherSchedule', 'summarizeStudentAttendance']],
    ['result',  ['countPublishedResults', 'listCampusResults', 'getRecentResultsForStudent']],
    ['department', ['getDepartmentCampusRef', 'findDepartmentForBulk', 'listDepartmentsForCampus']],
    ['settings', ['getLoginPrefs', 'getPreferredLanguage']],
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
