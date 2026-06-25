'use strict';

/**
 * @file gaet.repository.js — persistence layer of the GAET domain.
 *
 * ONLY file in the module allowed to query the GaetConstraint model
 * (controller + service + worker). Step 0 of the Postgres preparation — see
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * The model has no pre/post hooks (only virtuals): atomic status transitions
 * (findOneAndUpdate) are therefore faithful. The campus filter
 * (multi-tenant isolation, {schoolCampus}|{}) is built by the controller and
 * passed as a parameter.
 */

const GaetConstraint = require('./gaet-constraint.model');
const { GAET_STATUS } = GaetConstraint;

// ── Reads ────────────────────────────────────────────────────────────────────

/** Constraints of a campus (without the generated sessions — list views). */
const listForCampus = (query) =>
  GaetConstraint.find(query).select('-generatedSessions').lean();

/** "Status" view (polling). */
const findStatusView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status qualityReport generatedAt generatingStartedAt generationVersion academicYear semester schoolCampus')
    .lean();

/** "Preview" view (generated sessions). */
const findPreviewView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status generatedSessions qualityReport academicYear semester schoolCampus')
    .lean();

/** "Conflicts" view. */
const findConflictsView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status generatedSessions courseRequirements qualityReport')
    .lean();

/** Constraint by campus + year + semester (existence check). */
const findByYearSemester = (campusFilter, academicYear, semester) =>
  GaetConstraint.findOne({ ...campusFilter, academicYear, semester }).lean();

/** Constraint by id within the campus scope (fallback). */
const findInCampus = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter }).lean();

/** Read by id (generation worker). */
const findByIdLean = (id) => GaetConstraint.findById(id).lean();

// ── Writes (atomic transitions — no hook) ────────────────────────────────────

/** Upsert constraints for (campus, year, semester). @returns {Promise<Document>} */
const upsert = (campusFilter, academicYear, semester, $set) =>
  GaetConstraint.findOneAndUpdate(
    { ...campusFilter, academicYear, semester },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

/**
 * Atomically claims the constraint for generation (switches to GENERATING if
 * it is neither GENERATING nor PUBLISHED). Returns the doc BEFORE the update
 * (new:false) — or null if no match.
 */
const claimForGeneration = (campusFilter, academicYear, semester) =>
  GaetConstraint.findOneAndUpdate(
    {
      ...campusFilter, academicYear, semester,
      status: { $nin: [GAET_STATUS.GENERATING, GAET_STATUS.PUBLISHED] },
    },
    { $set: { status: GAET_STATUS.GENERATING, generatingStartedAt: new Date() } },
    { new: false },
  );

/** Restores the status + clears generatingStartedAt (pre-flight failure). */
const restoreStatus = (id, originalStatus) =>
  GaetConstraint.findByIdAndUpdate(id, { $set: { status: originalStatus, generatingStartedAt: null } });

/** Persists the generation worker result. */
const applyWorkerResult = (id, { status, sessions, report, generatedBy, generationVersion }) =>
  GaetConstraint.findByIdAndUpdate(id, {
    $set: {
      status,
      generatedSessions:   sessions || [],
      qualityReport:       report   || null,
      // A FAILED run produced no timetable — leave generatedAt unset so the
      // "generated on" stamp only reflects a real (full/partial) generation.
      generatedAt:         status === GAET_STATUS.FAILED ? null : new Date(),
      generatedBy,
      generatingStartedAt: null,
      generationVersion,
    },
  });

/** Marks a generation as failed. */
const markFailed = (id) =>
  GaetConstraint.findByIdAndUpdate(id, { $set: { status: GAET_STATUS.FAILED, generatingStartedAt: null } });

/** Marks the constraint as published. */
const markPublished = (id, publishedBy) =>
  GaetConstraint.findByIdAndUpdate(id, {
    $set: { status: GAET_STATUS.PUBLISHED, publishedAt: new Date(), publishedBy },
  });

/**
 * Atomically claims a generated (unpublished) timetable for publication.
 *
 * Transitions GENERATED | PARTIALLY_GENERATED → PUBLISHED in a single
 * findOneAndUpdate and returns the document BEFORE the update (new:false) so
 * the caller still has the full courseRequirements / generatedSessions payload
 * needed to materialise the schedule. Returns null when the current status
 * does not allow publication — which also makes the endpoint idempotent under
 * concurrent / double-clicked requests (only the first claim wins).
 *
 * @returns {Promise<Object|null>} pre-update lean doc (with virtuals) or null
 */
const claimForPublish = (id, campusFilter, publishedBy) =>
  GaetConstraint.findOneAndUpdate(
    {
      _id: id, ...campusFilter,
      status: { $in: [GAET_STATUS.GENERATED, GAET_STATUS.PARTIALLY_GENERATED] },
    },
    { $set: { status: GAET_STATUS.PUBLISHED, publishedAt: new Date(), publishedBy } },
    { new: false },
  ).lean({ virtuals: true });

/**
 * Reverts a failed publication: restores the original status and clears the
 * publication stamps set optimistically by claimForPublish.
 */
const restorePublishStatus = (id, originalStatus) =>
  GaetConstraint.findByIdAndUpdate(id, {
    $set:   { status: originalStatus },
    $unset: { publishedAt: '', publishedBy: '' },
  });

/**
 * Atomically cancels a generated (unpublished) timetable. Returns the updated
 * doc (new:true), or null if the current state does not allow it.
 */
const cancel = (id, campusFilter) =>
  GaetConstraint.findOneAndUpdate(
    {
      _id: id, ...campusFilter,
      status: { $in: [GAET_STATUS.GENERATED, GAET_STATUS.PARTIALLY_GENERATED, GAET_STATUS.FAILED] },
    },
    {
      $set: {
        status:              GAET_STATUS.CANCELLED,
        generatedSessions:   [],
        qualityReport:       null,
        generatedAt:         null,
        generatedBy:         null,
        generatingStartedAt: null,
      },
    },
    { new: true },
  );

/**
 * Recovers zombie jobs (GENERATING timed out) → FAILED.
 * @param {number} thresholdMs - minimum age of generatingStartedAt
 * @returns {Promise<number>} number of jobs recovered
 */
const recoverZombies = async (thresholdMs) => {
  const cutoff = new Date(Date.now() - thresholdMs);
  const result = await GaetConstraint.updateMany(
    { status: GAET_STATUS.GENERATING, generatingStartedAt: { $lt: cutoff } },
    { $set: { status: GAET_STATUS.FAILED, generatingStartedAt: null } },
  );
  return result.modifiedCount;
};

module.exports = {
  listForCampus,
  findStatusView,
  findPreviewView,
  findConflictsView,
  findByYearSemester,
  findInCampus,
  findByIdLean,
  upsert,
  claimForGeneration,
  restoreStatus,
  applyWorkerResult,
  markFailed,
  markPublished,
  claimForPublish,
  restorePublishStatus,
  cancel,
  recoverZombies,
};
