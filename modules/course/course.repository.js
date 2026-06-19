'use strict';

/**
 * @file course.repository.js — persistence layer of the course domain.
 *
 * The ONLY file in the module allowed to touch the Course model (crud/
 * workflow/resources controllers + service). Step 0 of the Postgres preparation — see
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Conventions:
 *  - Reads → plain objects (`.lean({ virtuals: true })` wherever the
 *    totalHours/prerequisiteCount virtuals are expected).
 *  - Writes → load→mutate→save: the model has pre('validate')/pre('save') hooks
 *    (slug, BFS prerequisite cycle prevention, resource MIME validation) that
 *    findByIdAndUpdate would bypass.
 *  - The versioning transaction (startSession/withTransaction) lives HERE.
 *  - Dynamic filters (buildCourseFilter) remain built by the
 *    controllers via course.helper and passed as a parameter — DAO boundary.
 */

const mongoose = require('mongoose');
const { Course, APPROVAL_STATUS } = require('./course.model');
const { COURSE_POPULATE } = require('./controllers/course.helper');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ACTIVE = { $ne: 'archived' };

// ── Reads ─────────────────────────────────────────────────────────────────

/** Number of active courses among a list of ids (prerequisite validation). */
const countExistingActive = (ids) =>
  Course.countDocuments({ _id: { $in: ids }, status: ACTIVE });

/**
 * Paginated list (filter provided by the controller), populate LIST, virtuals.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateList = async ({ filter, sort, skip, limit }) => {
  const [data, total] = await Promise.all([
    Course.find(filter).sort(sort).skip(skip).limit(limit)
      .populate(COURSE_POPULATE.LIST).lean({ virtuals: true }),
    Course.countDocuments(filter),
  ]);
  return { data, total };
};

/** Detail of an active course (populate DETAIL, virtuals). */
const findActiveByIdDetailed = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).populate(COURSE_POPULATE.DETAIL).lean({ virtuals: true });

/** Raw read of an active course (preconditions: approvalStatus, resources…). */
const findActiveByIdLean = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).lean();

/** Latest active version by code (populate DETAIL, virtuals). */
const findLatestActiveByCode = (code) =>
  Course.findOne({ courseCode: code, isLatestVersion: true, status: ACTIVE })
    .populate(COURSE_POPULATE.DETAIL).lean({ virtuals: true });

/** Code of an active course (version history resolution). */
const findCodeById = (id) =>
  Course.findOne({ _id: id, status: ACTIVE }).select('courseCode').lean();

/** Latest active version (raw read) — precursor to versioning. */
const findLatestActiveLean = (id) =>
  Course.findOne({ _id: id, status: ACTIVE, isLatestVersion: true }).lean();

/**
 * Paginated version history (same courseCode), sorted by version desc.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginateVersions = async (courseCode, { skip, limit }) => {
  const filter = { courseCode, status: ACTIVE };
  const [data, total] = await Promise.all([
    Course.find(filter).sort({ version: -1 }).skip(skip).limit(limit)
      .populate([
        { path: 'createdBy',             select: 'firstName lastName' },
        { path: 'approvalHistory.actor', select: 'firstName lastName' },
      ])
      .lean({ virtuals: true }),
    Course.countDocuments(filter),
  ]);
  return { data, total };
};

/** Active courses referencing `id` as a prerequisite (non-blocking warning). */
const listDependents = (id) =>
  Course.find({ 'prerequisites.course': id, status: ACTIVE })
    .select('courseCode title version approvalStatus').lean();

// ── Writes (load→mutate→save, hooks preserved) ──────────────────────────────

/** Creates a course and populates level + createdBy for the response. @returns {Promise<Document>} */
const create = async (data) => {
  const course = await Course.create(data);
  await course.populate([
    { path: 'level',     select: 'name description' },
    { path: 'createdBy', select: 'firstName lastName' },
  ]);
  return course;
};

/** Applies fields to an active course, save + populate DETAIL. @returns {Promise<Document|null>} */
const applyUpdate = async (id, updates) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  Object.assign(course, updates);
  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);
  return course;
};

/** Soft-delete (archive) of an active course. @returns {Promise<Document|null>} */
const archiveById = async (id, { deletedBy }) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.status    = 'archived';
  course.deletedAt = new Date();
  course.deletedBy = deletedBy;
  await course.save();
  return course;
};

/** Restores an archived course. @returns {Promise<Document|null>} */
const restoreById = async (id) => {
  const course = await Course.findOne({ _id: id, status: 'archived' });
  if (!course) return null;
  course.status    = 'active';
  course.deletedAt = undefined;
  course.deletedBy = undefined;
  await course.save();
  return course;
};

/**
 * Applies an approval status transition + history entry.
 * @returns {Promise<Document|null>}
 */
const applyStatusTransition = async (id, { newStatus, historyEntry }) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.approvalStatus = newStatus;
  course.approvalHistory.push(historyEntry);
  await course.save();
  await course.populate(COURSE_POPULATE.DETAIL);
  return course;
};

/**
 * Adds a resource to the active course (save → triggers MIME validation).
 * @returns {Promise<Object|null>} the added resource, or null if course not found
 */
const pushResource = async (id, entry) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.resources.push(entry);
  await course.save();
  return course.resources[course.resources.length - 1];
};

/**
 * Removes a resource (by sub-doc id) from the active course.
 * @returns {Promise<boolean|null>} true if removed, null if course not found
 */
const pullResource = async (id, resourceId) => {
  const course = await Course.findOne({ _id: id, status: ACTIVE });
  if (!course) return null;
  course.resources = course.resources.filter((r) => r._id.toString() !== resourceId);
  await course.save();
  return true;
};

/**
 * Clones an APPROVED course into a new DRAFT version (atomic transaction:
 * removes the old latest + inserts the new one). Owns the Mongoose session.
 * @param {{ original: Object, actorId: string, copyResources: boolean }} p
 * @returns {Promise<Document>} the new course, populated DETAIL
 * @throws {Error & { statusCode: 409 }} if the status changed concurrently
 */
const cloneAsNewVersion = async ({ original, actorId, copyResources }) => {
  const dbSession = await mongoose.startSession();
  let newCourse;
  try {
    await dbSession.withTransaction(async () => {
      // Re-check under transaction — guards against a concurrent approve/reject.
      const locked = await Course.findOne(
        { _id: original._id, approvalStatus: APPROVAL_STATUS.APPROVED, isLatestVersion: true },
        null,
        { session: dbSession },
      ).lean();

      if (!locked) {
        throw Object.assign(
          new Error('Course status changed concurrently. Please refresh and retry.'),
          { statusCode: 409 },
        );
      }

      await Course.findByIdAndUpdate(original._id, { isLatestVersion: false }, { session: dbSession });

      const {
        _id, __v, createdAt, updatedAt,
        slug, approvalStatus, approvalHistory, isLatestVersion, version, resources,
        ...cloneData
      } = original;

      const initNote = copyResources
        ? `New version v${version + 1} created from v${version} (resources copied)`
        : `New version v${version + 1} created from v${version} (resources not copied)`;

      const [created] = await Course.create(
        [
          {
            ...cloneData,
            resources:       copyResources ? (resources || []) : [],
            version:         version + 1,
            parentCourseId:  original._id,
            isLatestVersion: true,
            approvalStatus:  APPROVAL_STATUS.DRAFT,
            approvalHistory: [
              { status: APPROVAL_STATUS.DRAFT, note: initNote, actor: actorId, actedAt: new Date() },
            ],
            createdBy: actorId,
          },
        ],
        { session: dbSession },
      );

      newCourse = created;
    });
  } finally {
    await dbSession.endSession();
  }

  await newCourse.populate(COURSE_POPULATE.DETAIL);
  return newCourse;
};

// ── Cross-module API (former course.service) ──────────────────────────────────

/** Paginated catalogue of APPROVED courses (staff/mentor). @returns {Promise<{docs, total}>} */
const listApproved = async ({ search, page = 1, limit = 20 } = {}) => {
  const filter = {
    approvalStatus:  APPROVAL_STATUS.APPROVED,
    isLatestVersion: true,
    status:          ACTIVE,
  };
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: rx }, { courseCode: rx }, { description: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Course.find(filter).select('-__v')
      .populate('subject', 'subject_name').populate('createdBy', 'firstName lastName')
      .sort({ title: 1 }).skip(skip).limit(Number(limit)).lean(),
    Course.countDocuments(filter),
  ]);
  return { docs, total };
};

/** True if the teacher owns at least one of the courses (document access control). */
const teacherOwnsAnyCourse = async (courseIds, teacherId) => {
  const owned = await Course.findOne({ _id: { $in: courseIds }, teacher: teacherId }).select('_id').lean();
  return owned != null;
};

/** Course eligible for the Subject→Course link (level populated). */
const findApprovedForLinking = (courseId) =>
  Course.findOne({
    _id: courseId, status: ACTIVE,
    approvalStatus: APPROVAL_STATUS.APPROVED, isLatestVersion: true,
  }).populate('level', 'name').lean();

module.exports = {
  countExistingActive,
  paginateList,
  findActiveByIdDetailed,
  findActiveByIdLean,
  findLatestActiveByCode,
  findCodeById,
  findLatestActiveLean,
  paginateVersions,
  listDependents,
  create,
  applyUpdate,
  archiveById,
  restoreById,
  applyStatusTransition,
  pushResource,
  pullResource,
  cloneAsNewVersion,
  listApproved,
  teacherOwnsAnyCourse,
  findApprovedForLinking,
};
