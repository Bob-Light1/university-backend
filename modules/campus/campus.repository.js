'use strict';

/**
 * @file campus.repository.js — couche de persistance du domaine campus.
 *
 * Only file in the module allowed to query the Campus model directly
 * (controller + inter-module service). Step 0 of the Postgres migration preparation — see
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * NB: campus.config still provides Model: Campus to the shared GenericEntityController
 * (shared layer operating on a Model, outside the per-module repository scope).
 * The model has no pre/post hooks (only canAddX instance methods and the findActive static).
 */

const Campus = require('./campus.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

// ── Controller ────────────────────────────────────────────────────────────────

/** Creates a campus. @returns {Promise<Document>} (passed to GenericEntityController.afterCreate) */
const create = (data) => Campus.create(data);

/** Looks up by email (uniqueness check at creation). */
const findByEmail = (email) => Campus.findOne({ email }).lean();

/** Recherche par email AVEC le hash (login). */
const findByEmailWithPassword = (email) =>
  Campus.findOne({ email }).select('+password').lean();

/** Updates lastLogin (fire-and-forget). */
const touchLastLogin = (id) =>
  Campus.updateOne({ _id: id }, { $set: { lastLogin: new Date() } });

// Public-safe projection: never exposes PII (manager email/phone), business
// config (commissionConfig), quotas (features) or auth metadata (lastLogin)
// to unauthenticated / non-privileged callers of GET /campus/all.
const PUBLIC_FIELDS =
  'campus_name campus_number campus_image manager_name ' +
  'location.address location.city location.country status campusSlug createdAt';

/**
 * Paginated list. Filters: status/city/search.
 * @param {boolean} [publicView] — when true, restricts the projection to
 *   public-safe fields (no manager email/phone, commission config, quotas…).
 * @returns {Promise<{data, total}>}
 */
const paginate = async ({ status, city, search, skip, limit, publicView = false }) => {
  const filter = {};
  if (status) filter.status = status;
  if (city) filter['location.city'] = { $regex: escapeRegex(city), $options: 'i' };
  if (search) {
    const rx = (f) => ({ [f]: { $regex: escapeRegex(search), $options: 'i' } });
    filter.$or = [rx('campus_name'), rx('manager_name'), rx('email'), rx('campus_number')];
  }

  const projection = publicView ? PUBLIC_FIELDS : '-password';

  const [data, total] = await Promise.all([
    Campus.find(filter).select(projection).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campus.countDocuments(filter),
  ]);
  return { data, total };
};

/** Lecture sans mot de passe (getById / dashboard). */
const findByIdSafe = (id) => Campus.findById(id).select('-password').lean();

/** Lecture avec le hash (changement de mot de passe). */
const findByIdWithPassword = (id) => Campus.findById(id).select('+password').lean();

/** Updates the password (already hashed). */
const updatePassword = (id, hashedPassword) =>
  Campus.findByIdAndUpdate(id, { password: hashedPassword });

/** Updates the default preferences and returns the associated projection. */
const updateDefaults = (id, update) =>
  Campus.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true })
    .select('defaultLanguage defaultTimezone defaultGradeFormat campus_name').lean();

// ── Service inter-modules (ancien campus.service) ─────────────────────────────

const getCampusName = (campusId) =>
  Campus.findById(campusId).select('campus_name').lean();

const getCampusForPdf = (campusId) =>
  Campus.findById(campusId).select('campus_name campus_image location').lean();

const getCampusStorageInfo = (campusId) =>
  Campus.findById(campusId).select('features campus_name').lean();

const getCampusDefaults = (campusId) =>
  Campus.findById(campusId).select('defaultLanguage defaultTimezone defaultGradeFormat').lean();

/** Notification contact details for the campus account (email/phone/language). */
const getCampusNotificationContact = (campusId) =>
  Campus.findById(campusId).select('email manager_phone defaultLanguage').lean();

/**
 * Campus number/prefix (used for student ID generation, within a transaction
 * session). `opts.session` is propagated to participate in the calling transaction.
 */
const getCampusNumber = (campusId, { session } = {}) =>
  Campus.findById(campusId).select('campus_number').session(session ?? null).lean();

/** Full Mongoose document (instance methods — e.g. campus.canAddClass()). */
const getCampusDocById = (campusId) => Campus.findById(campusId);

const getCampusCommissionConfig = (campusId) =>
  Campus.findById(campusId).select('commissionConfig').lean();

/** Config de commission + nom du campus (back-office partner.commission). */
const getCampusCommissionConfigWithName = (campusId) =>
  Campus.findById(campusId).select('commissionConfig campus_name').lean();

/**
 * Updates the embedded commission config (back-office partner.commission).
 * @param {Object} cfg — { ruleType, fixedAmount, percentage, defaultCurrency, updatedBy }
 */
const setCampusCommissionConfig = (campusId, cfg) =>
  Campus.findByIdAndUpdate(
    campusId,
    { $set: {
      'commissionConfig.ruleType':        cfg.ruleType,
      'commissionConfig.fixedAmount':     cfg.fixedAmount,
      'commissionConfig.percentage':      cfg.percentage,
      'commissionConfig.defaultCurrency': cfg.defaultCurrency,
      'commissionConfig.updatedBy':       cfg.updatedBy,
      'commissionConfig.updatedAt':       new Date(),
    } },
    { new: true, runValidators: true }
  ).select('commissionConfig campus_name').lean();

/**
 * AI entitlement config (modules/ai gate middleware + admin read).
 *
 * BOTH objects are selected, and the caller picks: since phase 2 the AI reads
 * the unified `entitlement`, and falls back to the legacy `aiEntitlement` only
 * for a campus the migration has not reached yet (§3.2). One read, one
 * decision — `resolveAiEntitlement()` owns which side answers.
 */
const getCampusAiEntitlement = (campusId) =>
  Campus.findById(campusId).select('aiEntitlement entitlement campus_name status').lean();

/**
 * AI entitlement + audit trail (admin console only — audit is select:false
 * elsewhere). Both ledgers travel for the same reason as above: AI mutations
 * are appended to `entitlementAudit` since phase 2, while everything written
 * before that date still sits in `aiEntitlementAudit`.
 */
const getCampusAiEntitlementWithAudit = (campusId) =>
  Campus.findById(campusId)
    .select('aiEntitlement entitlement campus_name status +aiEntitlementAudit +entitlementAudit').lean();

/**
 * Replaces the embedded AI entitlement and appends an audit entry (append-only,
 * CLAUDE.md §8). `entitlement` is the FULL next config (merge done by the caller).
 * @param {Object} auditEntry — { actorId, actorRole, changes }
 */
const setCampusAiEntitlement = (campusId, entitlement, auditEntry) =>
  Campus.findByIdAndUpdate(
    campusId,
    { $set: { aiEntitlement: entitlement }, $push: { aiEntitlementAudit: auditEntry } },
    { new: true, runValidators: true }
  ).select('aiEntitlement campus_name').lean();

/**
 * Unified entitlement (CAMPUS_ENTITLEMENT_DESIGN.md). `.lean()` matters here:
 * the resolver must only ever see RAW DATA, never a Mongoose document, so the
 * whole entitlement chain survives the PostgreSQL migration untouched (§15bis.3).
 */
const getCampusEntitlement = (campusId) =>
  Campus.findById(campusId)
    // The legacy pair travels too: a campus the migration has not reached yet
    // is folded from it on its FIRST entitlement write, so the tier never lands
    // without its grandfathering (`entitlement.legacy.js`). Dropped from this
    // selector the day §3.2 removes the fields.
    .select('entitlement features aiEntitlement campus_name status').lean();

/** Entitlement + audit trail (admin console only — audit is select:false elsewhere). */
const getCampusEntitlementWithAudit = (campusId) =>
  Campus.findById(campusId)
    .select('entitlement campus_name status +entitlementAudit').lean();

/**
 * Replaces the entitlement object and appends an audit entry in the same write
 * (append-only, CLAUDE.md §8). `entitlement` is the FULL next value — the merge
 * belongs to the caller, which is the only party that knows which layer wrote.
 * @param {Object} auditEntry — { actorId, actorRole, changes }
 */
const setCampusEntitlement = (campusId, entitlement, auditEntry) =>
  Campus.findByIdAndUpdate(
    campusId,
    { $set: { entitlement }, $push: { entitlementAudit: auditEntry } },
    { new: true, runValidators: true }
  ).select('entitlement campus_name status').lean();

const getActiveCampusBySlug = (campusSlug, select = '_id') =>
  Campus.findOne({ campusSlug, status: 'active' }).select(select).lean();

const getActiveCampusById = (campusId, select) =>
  Campus.findOne({ _id: campusId, status: 'active' }).select(select).lean();

const listActivePublicCampuses = (select) =>
  Campus.find({ status: 'active', campusSlug: { $ne: null } })
    .select(select).sort({ campus_name: 1 }).lean();

module.exports = {
  // controller
  create,
  findByEmail,
  findByEmailWithPassword,
  touchLastLogin,
  paginate,
  findByIdSafe,
  findByIdWithPassword,
  updatePassword,
  updateDefaults,
  // service
  getCampusName,
  getCampusForPdf,
  getCampusStorageInfo,
  getCampusDefaults,
  getCampusNotificationContact,
  getCampusNumber,
  getCampusDocById,
  getCampusCommissionConfig,
  getCampusCommissionConfigWithName,
  setCampusCommissionConfig,
  getCampusAiEntitlement,
  getCampusAiEntitlementWithAudit,
  setCampusAiEntitlement,
  getCampusEntitlement,
  getCampusEntitlementWithAudit,
  setCampusEntitlement,
  getActiveCampusBySlug,
  getActiveCampusById,
  listActivePublicCampuses,
};
