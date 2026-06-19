'use strict';

/**
 * @file subject.repository.js — persistence layer of the subject domain.
 *
 * The ONLY file in the module allowed to touch the Subject model (subject.controller,
 * subject.course-link.controller, subject.service). Step 0 of the Postgres
 * preparation — see POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Reads → plain objects (`.lean()`); writes → load→mutate→save (preserves
 * the pre('save') hook and the schema setters).
 */

const Subject = require('./subject.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// ── Uniqueness checks ─────────────────────────────────────────────────────────

const findDuplicateCode = (campusId, code) =>
  Subject.findOne({ schoolCampus: campusId, subject_code: code }).lean();

const findDuplicateCodeExcept = (campusId, code, exceptId) =>
  Subject.findOne({ _id: { $ne: exceptId }, schoolCampus: campusId, subject_code: code }).lean();

// ── Reads (controller) ────────────────────────────────────────────────────────

/** Raw reference (preconditions: schoolCampus, status, courseRef…). */
const findByIdLean = (id) => Subject.findById(id).lean();

/** Standard response: campus_name populated. */
const findByIdForResponse = (id) =>
  Subject.findById(id).populate('schoolCampus', 'campus_name').lean();

/** Single-item view: campus_name + location populated. */
const findByIdDetailed = (id) =>
  Subject.findById(id).populate('schoolCampus', 'campus_name location').lean();

/** Campus refs for a batch of subjects (batch validation subjects∈campus — teacher.config). */
const getCampusRefsByIds = (subjectIds, { session } = {}) =>
  Subject.find({ _id: { $in: subjectIds } }).select('schoolCampus').session(session).lean();

/**
 * Paginated list (campus + status/category/search), campus_name populated,
 * sorted by subject_name.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginate = async ({ baseFilter, includeArchived, status, category, search, skip, limit }) => {
  const filter = { ...baseFilter };
  if (includeArchived !== true) {
    filter.status = { $ne: 'archived' };
  } else if (status && ['active', 'archived'].includes(status)) {
    filter.status = status;
  }
  if (category) filter.category = category;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ subject_name: rx }, { subject_code: rx }];
  }

  const [data, total] = await Promise.all([
    Subject.find(filter).sort({ subject_name: 1 }).skip(skip).limit(limit)
      .populate('schoolCampus', 'campus_name').lean(),
    Subject.countDocuments(filter),
  ]);
  return { data, total };
};

// ── Writes (load→save) ────────────────────────────────────────────────────────

/** Creates a subject. @returns {Promise<Document>} */
const create = (data) => Subject.create(data);

/** Applies the provided fields (load→assign→save). @returns {Promise<Document|null>} */
const updateById = async (id, fields) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  Object.assign(subject, fields);
  await subject.save();
  return subject;
};

/** Changes the status (active/archived). @returns {Promise<Document|null>} */
const setStatus = async (id, status) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  subject.status = status;
  await subject.save();
  return subject;
};

/** Sets (or clears with null) the courseRef. @returns {Promise<Document|null>} */
const setCourseRef = async (id, courseRef) => {
  const subject = await Subject.findById(id);
  if (!subject) return null;
  subject.courseRef = courseRef;
  await subject.save();
  return subject;
};

// ── Inter-module API (former subject.service) ─────────────────────────────────

/** Counts the subjects of a campus among a list of ids. */
const countOnCampus = (subjectIds, campusId) =>
  Subject.countDocuments({ _id: { $in: subjectIds }, schoolCampus: campusId });

/** Subjects of a campus (department + teachers populated). */
const listForCampus = ({ campusId, status }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  return Subject.find(filter)
    .populate('department', 'name')
    .populate('teachers',   'firstName lastName')
    .sort({ name: 1 })
    .lean();
};

/** Course ids referenced by at least one active subject. */
const distinctLinkedCourseRefs = () =>
  Subject.distinct('courseRef', { status: 'active', courseRef: { $ne: null } });

/** Active subjects referencing a course (schoolCampus.name populated). */
const listActiveLinkedToCourse = (courseId) =>
  Subject.find({ courseRef: courseId, status: 'active' })
    .select('schoolCampus subject_name')
    .populate('schoolCampus', 'name')
    .lean();

/** Campus reference of a subject. */
const getCampusRef = (subjectId) =>
  Subject.findById(subjectId).select('schoolCampus').lean();

/**
 * Denormalized subject{} shape for schedules (campus-isolated).
 * @returns {Promise<Object|null>}
 */
const resolveForSchedule = async (subjectId, campusId) => {
  if (!subjectId) return null;
  const doc = await Subject.findOne({
    _id:          subjectId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  }).select('_id subject_name subject_code coefficient department').lean();

  if (!doc) return null;
  return {
    subjectId:    doc._id,
    subject_name: doc.subject_name,
    subject_code: doc.subject_code,
    coefficient:  doc.coefficient ?? null,
    department:   doc.department  ?? null,
  };
};

module.exports = {
  findDuplicateCode,
  findDuplicateCodeExcept,
  findByIdLean,
  findByIdForResponse,
  findByIdDetailed,
  paginate,
  create,
  updateById,
  setStatus,
  setCourseRef,
  countOnCampus,
  listForCampus,
  distinctLinkedCourseRefs,
  listActiveLinkedToCourse,
  getCampusRef,
  getCampusRefsByIds,
  resolveForSchedule,
};
