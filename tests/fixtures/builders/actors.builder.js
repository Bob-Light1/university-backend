'use strict';

/**
 * @file actors.builder.js
 * @description Every signed-in actor of the fixture except the two global admins
 * and the campus managers (built with their campus): teachers, mentors,
 * students, parents, staff and their roles, plus the whole PARTNER surface.
 *
 * `Partner` / `PartnerLead` / `PartnerCommission` live here rather than in a
 * records builder because family C′ of CH-2 — partner-to-partner isolation
 * inside one campus — only means something if the three are built as one
 * coherent set: two sign-in partners per campus, each owning its own leads and
 * its own commissions (§4.9).
 *
 * Insertion order inside this builder is load-bearing: students are inserted
 * before parents because `Parent.pre('validate')` reads its children back from
 * the database to check they share its campus.
 */

const { oid, pad, stamps } = require('../ids');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR } = require('../seed.config');
const { ALL_PERMISSIONS } = require('../../../shared/constants/staff-permissions');

/**
 * Teachers. The last one on campus A is archived — the fixture needs an archived
 * actor whose rows are otherwise complete, so a "not deleted" filter that is
 * written the wrong way returns it.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildTeachers = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];

  return Array.from({ length: counts.teachers }, (_, i) => {
    const n = pad(i + 1);
    const archived = i >= counts.teachers - counts.teachersArchived;

    return {
      _id: oid(`teacher:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      department: oid(`department:${campusKey}:${pad((i % counts.departments) + 1)}`),
      subjects: [],
      classes: [],
      firstName: `Teacher${campusKey}${i + 1}`,
      lastName: 'Fixture',
      gender: i % 2 === 0 ? 'female' : 'male',
      dateOfBirth: ctx.at(-14000 - i),
      email: `teacher.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      phone: `+2376101${campusKey === 'A' ? '1' : '2'}${n}`,
      username: `teacher.${campusKey.toLowerCase()}${i + 1}`,
      password: ctx.passwordHash,
      qualification: 'MSc Fixture Studies',
      specialization: 'Fixture',
      experience: 5 + i,
      roles: ['TEACHER'],
      matricule: `TEA-${campusKey}-${n}`,
      hireDate: ctx.at(-900),
      employmentType: 'full-time',
      salary: 400000,
      ...stamps(350),
      ...(archived ? ctx.softDelete('Teacher', ctx.at(-40)) : { status: 'active' }),
    };
  });
};

/**
 * Mentors. The mentor ↔ student link is written on `Student.mentor` only —
 * `Mentor.students[]` is a virtual populate and writing to it produces nothing
 * (QA_TEST_STRATEGY.md §4.8).
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildMentors = (campusKey, ctx) =>
  Array.from({ length: COUNTS[campusKey].mentors }, (_, i) => {
    const n = pad(i + 1);

    return {
      _id: oid(`mentor:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      classes: [oid(`class:${campusKey}:${pad(i + 1)}`)],
      firstName: `Mentor${campusKey}${i + 1}`,
      lastName: 'Fixture',
      username: `mentor.${campusKey.toLowerCase()}${i + 1}`,
      email: `mentor.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      phone: `+2376201${campusKey === 'A' ? '1' : '2'}${n}`,
      password: ctx.passwordHash,
      specialization: 'Academic guidance',
      status: 'active',
      ...stamps(340),
    };
  });

/**
 * Students, carrying the status spread of §4.3 on campus A: active, pending,
 * suspended and archived all coexist. `pending` matters beyond variety — the
 * activation flow creates accounts in that state, and a stats query narrowed to
 * `status: 'active'` used to drop the whole imported cohort (CLAUDE.md §5.1).
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildStudents = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const liveClasses = counts.classes - counts.classesArchived;
  const mentors = COUNTS[campusKey].mentors;

  return Array.from({ length: counts.students }, (_, i) => {
    const n = pad(i + 1);
    const rank = i + 1;
    const archived = rank > counts.students - counts.studentsArchived;
    const suspended = !archived
      && rank > counts.students - counts.studentsArchived - counts.studentsSuspended;
    const pending = !archived && !suspended
      && rank > counts.students - counts.studentsArchived - counts.studentsSuspended - counts.studentsPending;

    const classIndex = i % liveClasses;
    const studentClass = oid(`class:${campusKey}:${pad(classIndex + 1)}`);

    let status = 'active';
    if (pending) status = 'pending';
    if (suspended) status = 'suspended';

    return {
      _id: oid(`student:${campusKey}:${n}`),
      firstName: `Student${campusKey}${rank}`,
      lastName: 'Fixture',
      dateOfBirth: ctx.at(-7300 - i),
      gender: i % 2 === 0 ? 'male' : 'female',
      email: `student.${campusKey.toLowerCase()}${rank}@fixture.test`,
      phone: `+2376301${campusKey === 'A' ? '1' : '2'}${n}`,
      username: `student.${campusKey.toLowerCase()}${rank}`,
      password: ctx.passwordHash,
      schoolCampus: ctx.campusIds[campusKey],
      studentClass,
      mentor: mentors > 0 ? oid(`mentor:${campusKey}:${pad((i % mentors) + 1)}`) : null,
      matricule: `STU-${campusKey}-${n}`,
      enrollmentDate: ctx.at(-300),
      cardNumber: `CARD-${campusKey}-${n}`,
      cardValidUntil: ctx.at(180),
      emergencyContact: { name: 'Fixture Contact', phone: '+237600000099', relationship: 'guardian' },
      ...stamps(300 - i),
      ...(archived ? ctx.softDelete('Student', ctx.at(-25)) : { status }),
    };
  });
};

/**
 * Parents. The first one on each campus carries two children — the dashboards
 * that pick `children[0]` silently need a second child to be caught.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildParents = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const relationships = ['father', 'mother', 'guardian', 'other'];
  let nextChild = 1;

  return Array.from({ length: counts.parents }, (_, i) => {
    const n = pad(i + 1);
    const childCount = i === 0 ? 2 : 1;
    const children = Array.from({ length: childCount }, () => oid(`student:${campusKey}:${pad(nextChild++)}`));
    const sequence = campusKey === 'A' ? i + 1 : COUNTS.A.parents + i + 1;

    return {
      _id: oid(`parent:${campusKey}:${n}`),
      firstName: `Parent${campusKey}${i + 1}`,
      lastName: 'Fixture',
      email: `parent.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      username: `parent.${campusKey.toLowerCase()}${i + 1}`,
      phone: `+2376401${campusKey === 'A' ? '1' : '2'}${n}`,
      password: ctx.passwordHash,
      gender: i % 2 === 0 ? 'male' : 'female',
      dateOfBirth: ctx.at(-16000 - i),
      occupation: 'Fixture occupation',
      schoolCampus: ctx.campusIds[campusKey],
      children,
      relationship: relationships[i % relationships.length],
      status: 'active',
      preferredLanguage: campusKey === 'A' ? 'fr' : 'en',
      // Written explicitly: `parentRef` comes from a counter in `pre('save')`,
      // which `insertMany` does not run. The counters collection is realigned
      // at the end of the seed so the application keeps numbering from here.
      parentRef: `PAR-${ctx.anchorYear}-${String(sequence).padStart(5, '0')}`,
      ...stamps(295),
    };
  });
};

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildStaffRoles = (campusKey, ctx) =>
  Array.from({ length: COUNTS[campusKey].staffRoles }, (_, i) => ({
    _id: oid(`staff-role:${campusKey}:${pad(i + 1)}`),
    campus: ctx.campusIds[campusKey],
    name: `Role ${campusKey}${i + 1}`,
    description: `Fixture staff role ${campusKey}${i + 1}`,
    // Imported, never restated: the model validates against this very list, and
    // a test that hard-codes a permission key is a second source of truth (R6).
    permissions: ALL_PERMISSIONS.slice(0, 4 + i),
    isActive: true,
    createdBy: ctx.adminIds.ADMIN,
    ...stamps(290),
  }));

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildStaff = (campusKey, ctx) =>
  Array.from({ length: COUNTS[campusKey].staff }, (_, i) => {
    const n = pad(i + 1);

    return {
      _id: oid(`staff:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      subRole: oid(`staff-role:${campusKey}:${pad((i % COUNTS[campusKey].staffRoles) + 1)}`),
      firstName: `Staff${campusKey}${i + 1}`,
      lastName: 'Fixture',
      username: `staff.${campusKey.toLowerCase()}${i + 1}`,
      email: `staff.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      phone: `+2376501${campusKey === 'A' ? '1' : '2'}${n}`,
      password: ctx.passwordHash,
      status: 'active',
      ...stamps(285),
    };
  });

/**
 * Partners. The first two of each campus own a sign-in account (`partnerCode`,
 * `partnerType`, password): without a SECOND partner in the SAME campus, family
 * C′ has no target and would be green while asserting nothing (§4.9).
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildPartners = (campusKey, ctx) =>
  Array.from({ length: COUNTS[campusKey].partners }, (_, i) => {
    const n = pad(i + 1);
    const hasAccount = i < COUNTS[campusKey].partnerAccounts;

    return {
      _id: oid(`partner:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      firstName: `Partner${campusKey}${i + 1}`,
      lastName: 'Fixture',
      email: `partner.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      phone: `+2376601${campusKey === 'A' ? '1' : '2'}${n}`,
      gender: i % 2 === 0 ? 'female' : 'male',
      organization: `Fixture Org ${campusKey}${i + 1}`,
      password: ctx.passwordHash,
      partnerType: i % 2 === 0 ? 'institutional' : 'commercial',
      institutionType: i % 2 === 0 ? 'company' : null,
      commercialType: i % 2 === 0 ? null : 'influencer',
      channelType: 'hybrid',
      tier: 'silver',
      status: 'active',
      // Written explicitly for the same reason as `parentRef`: the model mints it
      // in `pre('save')`, and the referral link `/r/{code}` must stay constant
      // across runs for CH-4 to be able to capture it.
      partnerCode: hasAccount ? `${campusKey}PART${n}` : null,
      referralStats: { linkClicks: 10 * (i + 1), qrScans: 5 * (i + 1), lastReferralHitAt: ctx.at(-3) },
      ...stamps(280),
    };
  });

/**
 * Leads, split evenly across the campus's two sign-in partners.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildPartnerLeads = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const sources = ['qr_code', 'referral_link', 'manual_code'];
  const statuses = ['new', 'contacted', 'admitted'];

  return Array.from({ length: counts.partnerLeads }, (_, i) => {
    const n = pad(i + 1);
    const ownerIndex = i % counts.partnerAccounts;

    return {
      _id: oid(`partner-lead:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      partner: oid(`partner:${campusKey}:${pad(ownerIndex + 1)}`),
      partnerCode: `${campusKey}PART${pad(ownerIndex + 1)}`,
      firstName: `Lead${campusKey}${i + 1}`,
      lastName: 'Fixture',
      email: `lead.${campusKey.toLowerCase()}${i + 1}@fixture.test`,
      phone: `+2376701${campusKey === 'A' ? '1' : '2'}${n}`,
      programInterest: 'Software Engineering',
      city: 'Douala',
      country: 'Cameroon',
      source: sources[i % sources.length],
      status: statuses[i % statuses.length],
      ...stamps(60 - i),
    };
  });
};

/**
 * Commissions, each attached to a lead of the same partner. A commission whose
 * lead belongs to the other partner would make family C′ ambiguous.
 *
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildPartnerCommissions = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const statuses = ['pending', 'validated', 'paid', 'pending'];

  return Array.from({ length: counts.partnerCommissions }, (_, i) => {
    const n = pad(i + 1);
    const ownerIndex = i % counts.partnerAccounts;

    return {
      _id: oid(`partner-commission:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      partner: oid(`partner:${campusKey}:${pad(ownerIndex + 1)}`),
      lead: oid(`partner-lead:${campusKey}:${pad(i + 1)}`),
      amount: 25000,
      currency: 'XAF',
      ruleSnapshot: { ruleType: 'FIXED', fixedAmount: 25000, percentage: null, currency: 'XAF', tier: 'silver' },
      status: statuses[i % statuses.length],
      notes: `Fixture commission ${campusKey}${i + 1}`,
      ...stamps(50 - i),
    };
  });
};

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const build = (ctx) => {
  const teachers = {};
  const students = {};
  const byCampus = (fn) => CAMPUS_KEYS.flatMap((key) => fn(key, ctx));

  CAMPUS_KEYS.forEach((key) => { teachers[key] = buildTeachers(key, ctx); });
  ctx.teachers = teachers;
  ctx.teacherIds = Object.fromEntries(CAMPUS_KEYS.map((k) => [k, teachers[k].map((t) => t._id)]));

  const mentors = byCampus(buildMentors);

  CAMPUS_KEYS.forEach((key) => { students[key] = buildStudents(key, ctx); });
  ctx.students = students;

  // The class roster is derived from the students, never restated: a student in
  // `Class.students` who is not in the class is the kind of drift that makes a
  // count test pass while a screen shows something else.
  ctx.studentsByClass = {};
  CAMPUS_KEYS.forEach((key) => {
    students[key].forEach((student) => {
      const classId = String(student.studentClass);
      (ctx.studentsByClass[classId] ||= []).push(student._id);
    });
  });

  const parents = byCampus(buildParents);
  const staffRoles = byCampus(buildStaffRoles);
  const staff = byCampus(buildStaff);
  const partners = byCampus(buildPartners);
  const leads = byCampus(buildPartnerLeads);
  const commissions = byCampus(buildPartnerCommissions);

  ctx.parentCount = parents.length;
  ctx.academicYear = ACADEMIC_YEAR;

  return [
    { model: 'Teacher', docs: CAMPUS_KEYS.flatMap((k) => teachers[k]) },
    { model: 'Mentor', docs: mentors },
    { model: 'Student', docs: CAMPUS_KEYS.flatMap((k) => students[k]) },
    { model: 'Parent', docs: parents },
    { model: 'StaffRole', docs: staffRoles },
    { model: 'Staff', docs: staff },
    { model: 'Partner', docs: partners },
    { model: 'PartnerLead', docs: leads },
    { model: 'PartnerCommission', docs: commissions },
  ];
};

module.exports = { build };
