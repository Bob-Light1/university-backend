'use strict';

/**
 * @file campus.builder.js
 * @description Builds the isolation boundary itself — two campuses — and the two
 * global accounts (ADMIN, DIRECTOR) that are scoped to none of them.
 *
 * The campus document is also the CAMPUS_MANAGER credential store: the danger
 * zone re-authenticates that role against `Campus` (CLAUDE.md §5.2), and
 * `POST /api/campus/login` signs its token from these very fields. Seeding a
 * campus therefore seeds a sign-in account, not just a tenant row.
 */

const { oid, stamps } = require('../ids');
const { COUNTS } = require('../seed.config');

/** Campus A runs on the paid AI tier: `/api/ai` is untestable on a campus without one. */
const AI_ENTITLEMENT = Object.freeze({
  enabled: true,
  plan: 'premium',
  llmProfile: 'premium',
  monthlyTokenBudget: 5000000,
  features: { chat: true, search: true, analytics: true, advisors: true },
  activatedAt: null,
});

/**
 * Quotas wide enough that a creation test never fails for a reason unrelated to
 * what it tests (QA_TEST_STRATEGY.md §4.8).
 */
const QUOTAS = Object.freeze({
  maxStudents: 5000,
  maxTeachers: 500,
  maxClasses: 200,
  maxDocumentStorageMB: 10240,
});

/**
 * @param {Object} ctx - Seed context (password hash, anchor-relative clock).
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const build = (ctx) => {
  const campuses = [
    {
      _id: oid('campus:A'),
      campus_name: 'Fixture Campus A',
      campus_number: 'FIX-A',
      manager_name: 'Amina Fixture',
      manager_phone: '+237600000001',
      email: 'campus.a@fixture.test',
      password: ctx.passwordHash,
      location: { address: '1 Test Street', city: 'Douala', country: 'Cameroon' },
      status: 'active',
      campusSlug: 'fixture-campus-a',
      programs: ['Software Engineering', 'Business Administration'],
      nextBatchDate: ctx.at(45),
      defaultLanguage: 'fr',
      defaultTimezone: 'Africa/Douala',
      defaultGradeFormat: 'FRACTION',
      aiEntitlement: AI_ENTITLEMENT,
      features: QUOTAS,
      commissionConfig: {
        ruleType: 'FIXED',
        fixedAmount: 25000,
        percentage: null,
        defaultCurrency: 'XAF',
        updatedAt: ctx.at(-200),
      },
      ...stamps(400),
    },
    {
      _id: oid('campus:B'),
      campus_name: 'Fixture Campus B',
      campus_number: 'FIX-B',
      manager_name: 'Brice Fixture',
      manager_phone: '+237600000002',
      email: 'campus.b@fixture.test',
      password: ctx.passwordHash,
      location: { address: '2 Test Avenue', city: 'Yaoundé', country: 'Cameroon' },
      status: 'active',
      campusSlug: 'fixture-campus-b',
      programs: ['Nursing'],
      nextBatchDate: ctx.at(60),
      defaultLanguage: 'en',
      defaultTimezone: 'Africa/Douala',
      defaultGradeFormat: 'PERCENT',
      features: QUOTAS,
      commissionConfig: {
        ruleType: 'PERCENTAGE',
        fixedAmount: null,
        percentage: 10,
        defaultCurrency: 'XAF',
        updatedAt: ctx.at(-200),
      },
      ...stamps(390),
    },
  ];

  const admins = [
    {
      _id: oid('admin:global:admin'),
      admin_name: 'Fixture Admin',
      email: 'admin@fixture.test',
      password: ctx.passwordHash,
      role: 'ADMIN',
      status: 'active',
      isBootstrap: true,
      ...stamps(400),
    },
    {
      _id: oid('admin:global:director'),
      admin_name: 'Fixture Director',
      email: 'director@fixture.test',
      password: ctx.passwordHash,
      role: 'DIRECTOR',
      status: 'active',
      createdBy: oid('admin:global:admin'),
      ...stamps(395),
    },
  ];

  ctx.campusIds = { A: campuses[0]._id, B: campuses[1]._id };
  ctx.adminIds = { ADMIN: admins[0]._id, DIRECTOR: admins[1]._id };
  ctx.campusDocs = campuses;
  ctx.adminDocs = admins;

  if (admins.length !== COUNTS.GLOBAL.admins) {
    throw new Error(`campus.builder: expected ${COUNTS.GLOBAL.admins} admins, built ${admins.length}`);
  }

  return [
    { model: 'Campus', docs: campuses },
    { model: 'Admin', docs: admins },
  ];
};

module.exports = { build };
