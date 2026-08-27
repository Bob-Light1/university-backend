'use strict';

/**
 * @file verify.js
 * @description Post-seed integrity assertions.
 *
 * The fixture is only worth what this file proves about it. Every expectation is
 * read from `seed.config.js` — never restated here — so a volume can be changed
 * in exactly one place, and a builder that silently stops producing rows fails
 * the run instead of quietly shrinking the dataset every suite above depends on.
 *
 * Deletion is never asserted with a hand-written filter: `notDeletedFilter()` and
 * `deletedOnlyFilter()` derive it from the model, which is the only way the three
 * conventions cannot be mixed up (CLAUDE.md §5.1, R7).
 */

const { notDeletedFilter, deletedOnlyFilter } = require('../../shared/utils/soft-delete');
const { preDueWindow, dueReminderKind, REMINDER_KIND_VALUES } = require('../../modules/finance/fee-reminder-kind');
const { model } = require('./models');
const { oid } = require('./ids');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR, ANCHOR_DATE } = require('./seed.config');

/** Campus path per model — three field names coexist in this repo (§4.8). */
const CAMPUS_PATH = Object.freeze({
  Teacher: 'schoolCampus',
  Student: 'schoolCampus',
  Parent: 'schoolCampus',
  Mentor: 'schoolCampus',
  Staff: 'schoolCampus',
  StaffRole: 'campus',
  Class: 'schoolCampus',
  Department: 'schoolCampus',
  Subject: 'schoolCampus',
  Partner: 'schoolCampus',
  PartnerLead: 'schoolCampus',
  PartnerCommission: 'schoolCampus',
  GradingScale: 'schoolCampus',
  Result: 'schoolCampus',
  Announcement: 'schoolCampus',
  Document: 'campusId',
  Income: 'schoolCampus',
  Expense: 'schoolCampus',
  StudentFee: 'schoolCampus',
  FeePayment: 'schoolCampus',
  ExamSession: 'schoolCampus',
  ExamEnrollment: 'schoolCampus',
  ExamSubmission: 'schoolCampus',
  ExamGrading: 'schoolCampus',
  StudentSchedule: 'schoolCampus',
  TeacherSchedule: 'schoolCampus',
});

/** Per-campus totals, keyed by the count declared in `seed.config.js`. */
const CAMPUS_TOTALS = Object.freeze({
  Teacher: 'teachers',
  Student: 'students',
  Parent: 'parents',
  Mentor: 'mentors',
  Staff: 'staff',
  StaffRole: 'staffRoles',
  Class: 'classes',
  Department: 'departments',
  Subject: 'subjects',
  Partner: 'partners',
  PartnerLead: 'partnerLeads',
  PartnerCommission: 'partnerCommissions',
  Result: 'results',
  Announcement: 'announcements',
  Document: 'documents',
  Income: 'incomes',
  Expense: 'expenses',
  StudentFee: 'studentFees',
  FeePayment: 'feePayments',
  ExamSession: 'examSessions',
  ExamEnrollment: 'examEnrollments',
  ExamSubmission: 'examSubmissions',
  ExamGrading: 'examGradings',
});

/**
 * Collects checks, then reports every failure at once: a verifier that stops on
 * the first mismatch turns one broken run into several.
 */
class Report {
  constructor() {
    this.checks = [];
  }

  /**
   * @param {string} label
   * @param {*} actual
   * @param {*} expected
   */
  expect(label, actual, expected) {
    this.checks.push({ label, actual, expected, ok: actual === expected });
  }

  /** @returns {Array<Object>} */
  get failures() {
    return this.checks.filter((c) => !c.ok);
  }
}

/**
 * @param {string} name
 * @param {string} campusKey
 * @param {Object} campusIds
 * @returns {Object} Campus-scoped filter for that model.
 */
const scope = (name, campusKey, campusIds) => ({ [CAMPUS_PATH[name]]: campusIds[campusKey] });

/**
 * Runs every assertion against the seeded database.
 *
 * @param {Object} [options]
 * @param {boolean} [options.silent=false] - Suppress the per-check console output.
 * @returns {Promise<Report>}
 * @throws {Error} When at least one expectation is not met.
 */
const verify = async ({ silent = false } = {}) => {
  const report = new Report();
  const campusIds = { A: oid('campus:A'), B: oid('campus:B') };

  // ── Boundary and global collections ────────────────────────────────────────
  report.expect('Campus count', await model('Campus').countDocuments({}), CAMPUS_KEYS.length);
  report.expect('Admin count', await model('Admin').countDocuments({}), COUNTS.GLOBAL.admins);
  report.expect('Level count (global)', await model('Level').countDocuments({}), COUNTS.GLOBAL.levels);
  report.expect('Course count (global)', await model('Course').countDocuments({}), COUNTS.GLOBAL.courses);
  report.expect(
    'ExpenseCategory count (global)',
    await model('ExpenseCategory').countDocuments({}),
    COUNTS.GLOBAL.expenseCategories
  );

  // ── Per-campus volumes ─────────────────────────────────────────────────────
  for (const campusKey of CAMPUS_KEYS) {
    for (const [name, countKey] of Object.entries(CAMPUS_TOTALS)) {
      report.expect(
        `${name} count — campus ${campusKey}`,
        await model(name).countDocuments(scope(name, campusKey, campusIds)),
        COUNTS[campusKey][countKey]
      );
    }

    const scheduleTotal = COUNTS[campusKey].scheduleSlots + COUNTS[campusKey].scheduleSlotsDeleted;
    for (const name of ['StudentSchedule', 'TeacherSchedule']) {
      report.expect(
        `${name} count — campus ${campusKey}`,
        await model(name).countDocuments(scope(name, campusKey, campusIds)),
        scheduleTotal
      );
      report.expect(
        `${name} live slots — campus ${campusKey}`,
        await model(name).countDocuments({
          ...scope(name, campusKey, campusIds),
          ...notDeletedFilter(model(name)),
        }),
        COUNTS[campusKey].scheduleSlots
      );
    }
  }

  // ── Deletion conventions, derived from the models ──────────────────────────
  const deletionChecks = [
    ['Teacher', 'teachers', 'teachersArchived'],
    ['Student', 'students', 'studentsArchived'],
    ['Class', 'classes', 'classesArchived'],
    ['Result', 'results', 'resultsDeleted'],
    ['Document', 'documents', 'documentsDeleted'],
    ['Announcement', 'announcements', 'announcementsDeleted'],
    ['Income', 'incomes', 'incomesDeleted'],
    ['Expense', 'expenses', 'expensesDeleted'],
    ['StudentFee', 'studentFees', 'studentFeesDeleted'],
  ];

  for (const campusKey of CAMPUS_KEYS) {
    for (const [name, totalKey, deletedKey] of deletionChecks) {
      const Model = model(name);
      const base = scope(name, campusKey, campusIds);
      const expectedDeleted = COUNTS[campusKey][deletedKey];

      report.expect(
        `${name} soft-deleted — campus ${campusKey}`,
        await Model.countDocuments({ ...base, ...deletedOnlyFilter(Model) }),
        expectedDeleted
      );
      report.expect(
        `${name} live — campus ${campusKey}`,
        await Model.countDocuments({ ...base, ...notDeletedFilter(Model) }),
        COUNTS[campusKey][totalKey] - expectedDeleted
      );
    }
  }

  // ── The three domain traps of §4.3 ─────────────────────────────────────────
  const Result = model('Result');
  const Announcement = model('Announcement');
  const Document = model('Document');
  const campusA = campusIds.A;

  report.expect(
    'TRAP 1 — soft-deleted results keep status PUBLISHED',
    await Result.countDocuments({
      schoolCampus: campusA,
      ...deletedOnlyFilter(Result),
      status: 'PUBLISHED',
    }),
    COUNTS.A.resultsDeleted
  );
  report.expect(
    'TRAP 1 — ARCHIVED results are live',
    await Result.countDocuments({
      schoolCampus: campusA,
      ...notDeletedFilter(Result),
      status: 'ARCHIVED',
    }),
    COUNTS.A.resultsArchivedAlive
  );
  report.expect(
    'TRAP 2 — expired announcements (status archived) are live',
    await Announcement.countDocuments({
      schoolCampus: campusA,
      ...notDeletedFilter(Announcement),
      status: 'archived',
    }),
    COUNTS.A.announcementsExpiredAlive
  );
  report.expect(
    'TRAP 2 — deleted announcements keep status published',
    await Announcement.countDocuments({
      schoolCampus: campusA,
      ...deletedOnlyFilter(Announcement),
      status: 'published',
    }),
    COUNTS.A.announcementsDeleted
  );
  report.expect(
    'TRAP 3 — soft-deleted documents keep status PUBLISHED',
    await Document.countDocuments({
      campusId: campusA,
      ...deletedOnlyFilter(Document),
      status: 'PUBLISHED',
    }),
    COUNTS.A.documentsDeleted
  );

  // ── Invariants the upper layers rely on ────────────────────────────────────
  for (const campusKey of CAMPUS_KEYS) {
    report.expect(
      `Exactly one default grading scale — campus ${campusKey}`,
      await model('GradingScale').countDocuments({ schoolCampus: campusIds[campusKey], isDefault: true }),
      1
    );
    report.expect(
      `Sign-in partners — campus ${campusKey}`,
      await model('Partner').countDocuments({
        schoolCampus: campusIds[campusKey],
        partnerCode: { $ne: null },
      }),
      COUNTS[campusKey].partnerAccounts
    );

    // Family C′ needs each sign-in partner to own leads AND commissions of its own.
    for (let i = 1; i <= COUNTS[campusKey].partnerAccounts; i += 1) {
      const partnerId = oid(`partner:${campusKey}:${String(i).padStart(3, '0')}`);
      const leads = await model('PartnerLead').countDocuments({ partner: partnerId });
      const commissions = await model('PartnerCommission').countDocuments({ partner: partnerId });

      report.expect(`Partner ${campusKey}${i} owns leads`, leads > 0, true);
      report.expect(`Partner ${campusKey}${i} owns commissions`, commissions > 0, true);
    }

    report.expect(
      `Student status spread — pending, campus ${campusKey}`,
      await model('Student').countDocuments({ schoolCampus: campusIds[campusKey], status: 'pending' }),
      COUNTS[campusKey].studentsPending
    );
    report.expect(
      `Student status spread — suspended, campus ${campusKey}`,
      await model('Student').countDocuments({ schoolCampus: campusIds[campusKey], status: 'suspended' }),
      COUNTS[campusKey].studentsSuspended
    );

    const parentWithTwo = await model('Parent').countDocuments({
      schoolCampus: campusIds[campusKey],
      'children.1': { $exists: true },
    });
    report.expect(`A parent has two children — campus ${campusKey}`, parentWithTwo >= 1, true);
  }

  // Mentor attachment travels on Student.mentor only (Mentor.students is virtual).
  report.expect(
    'Students carry a mentor reference',
    await model('Student').countDocuments({ mentor: { $ne: null } }),
    COUNTS.A.students + COUNTS.B.students
  );

  // One subject with coefficient 0 — the weighted average has divided by it before.
  report.expect(
    'Campus A has a coefficient-0 subject',
    await model('Subject').countDocuments({ schoolCampus: campusA, coefficient: 0 }),
    1
  );

  // Overdue debts, computed against the anchor rather than the wall clock.
  for (const campusKey of CAMPUS_KEYS) {
    report.expect(
      `Overdue student fees — campus ${campusKey}`,
      await model('StudentFee').countDocuments({
        schoolCampus: campusIds[campusKey],
        status: 'overdue',
      }),
      COUNTS[campusKey].studentFeesOverdue
    );
  }

  // Pre-due debts: the window the 07:00 sweep reads, derived from the cadence
  // itself and evaluated at the anchor. A fixture whose every live debt sits 30
  // days out lets that job report zero for ever without anyone noticing.
  const { from, to } = preDueWindow(ANCHOR_DATE);
  for (const campusKey of CAMPUS_KEYS) {
    const dueSoon = await model('StudentFee').find({
      schoolCampus: campusIds[campusKey],
      ...notDeletedFilter(model('StudentFee')),
      status: { $in: ['pending', 'partial'] },
      dueDate: { $gte: from, $lt: to },
    }).lean();

    report.expect(
      `Debts inside the pre-due window — campus ${campusKey}`,
      dueSoon.length,
      COUNTS[campusKey].studentFeesDueSoon
    );

    if (COUNTS[campusKey].studentFeesDueSoon) {
      // One debt per kind, and each one still owing something: a settled debt
      // is in the window but is not remindable.
      // Compared as a boolean rather than as a literal string: an expectation
      // here may never restate a volume or a list — those belong to their source
      // of truth (`COUNTS`, and the cadence module for the kinds).
      const kinds = dueSoon.map((fee) => dueReminderKind(fee.dueDate, ANCHOR_DATE)).sort();
      report.expect(
        `One debt per pre-due kind — campus ${campusKey}`,
        kinds.join(',') === [...REMINDER_KIND_VALUES].sort().join(','),
        true
      );
      report.expect(
        `Every pre-due debt still owes — campus ${campusKey}`,
        dueSoon.every((fee) => fee.amountPaid < fee.amountDue),
        true
      );
      report.expect(
        `No pre-due notice recorded yet — campus ${campusKey}`,
        dueSoon.every((fee) => (fee.remindersSent || []).length === 0),
        true
      );
    }
  }

  // Stable identifiers: the whole point of the deterministic derivation.
  const anchorStudent = await model('Student').findById(oid('student:A:001')).lean();
  report.expect('Anchor student STU-A-001 exists', anchorStudent?.matricule, 'STU-A-001');
  report.expect('Anchor student belongs to campus A', String(anchorStudent?.schoolCampus), String(campusA));
  report.expect('Anchor academic year', anchorStudent ? ACADEMIC_YEAR : null, ACADEMIC_YEAR);

  // AI surface: `/api/ai` answers uniformly on a campus without an entitlement.
  const campusADoc = await model('Campus').findById(campusA).lean();
  report.expect('Campus A carries an AI entitlement', campusADoc?.aiEntitlement?.enabled, true);

  // Counters: matricule and reference generation must continue past the fixture.
  const resultCounter = await model('Counter').findById(`result_${ANCHOR_DATE.getUTCFullYear()}`).lean();
  report.expect(
    'Result counter realigned past the fixture',
    resultCounter?.seq,
    COUNTS.A.results + COUNTS.B.results
  );

  if (!silent) {
    report.checks.forEach((check) => {
      if (!check.ok) {
        console.error(`  ✗ ${check.label}: expected ${check.expected}, got ${check.actual}`);
      }
    });
  }

  if (report.failures.length > 0) {
    // Only the first few are quoted: every failure was printed line by line above,
    // and an empty database fails a hundred checks at once — a message carrying
    // all of them is the one nobody reads.
    const quoted = report.failures
      .slice(0, 5)
      .map((f) => `${f.label} (expected ${f.expected}, got ${f.actual})`)
      .join(' | ');
    const rest = report.failures.length - 5;

    throw new Error(
      `Fixture verification failed: ${report.failures.length} of ${report.checks.length} checks. ` +
      `${quoted}${rest > 0 ? ` … and ${rest} more` : ''}`
    );
  }

  return report;
};

module.exports = { verify, CAMPUS_PATH };
