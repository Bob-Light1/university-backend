'use strict';

/**
 * @file campus.service.js — API inter-modules du domaine campus.
 *
 * Exposed:
 *   - getCampusName             : campus name (document headers).
 *   - getCampusForPdf           : name + logo + location (academic PDF rendering).
 *   - getCampusDefaults         : default language/timezone/grade format (settings).
 *   - getCampusNumber           : number/prefix (student ID generation, in session).
 *   - getCampusDocById          : full Mongoose document (instance methods — class.canAddClass).
 *   - getCampusCommissionConfig : commission config (partner.lead).
 *   - getCampusCommissionConfigWithName : config + campus name (partner.commission).
 *   - setCampusCommissionConfig : updates the config (partner.commission).
 *   - getCampusAiEntitlement    : AI entitlement config (ai gate middleware, admin read).
 *   - setCampusAiEntitlement    : replaces the AI entitlement + audit entry (admin).
 *   - getCampusEntitlement      : unified entitlement (gate middleware, admin/campus read).
 *   - getCampusEntitlementWithAudit : entitlement + audit trail (admin console).
 *   - listCampusEntitlements    : every configured entitlement (background jobs, §9.1).
 *   - listCampusesForEstate     : every campus + raw entitlement (admin estate matrix).
 *   - setCampusEntitlement      : replaces the entitlement + audit entry (both layers).
 *   - getActiveCampusBySlug     : public portal resolution by slug (active status).
 *   - getActiveCampusById       : public portal resolution by _id (active status).
 *   - listActivePublicCampuses  : list of public campuses (portal selector).
 *
 * NB: consumers require this facade via LAZY require
 * (`require('../../campus').service` at call time) because the campus module is a hub
 * that itself requires many modules (settings, teacher, student, class,
 * finance, department, staff, mentor) — a static require would create cycles.
 */

const campusRepo = require('./campus.repository');

// All persistence goes through campus.repository (step 0 pre-Postgres).
const getCampusName             = (campusId) => campusRepo.getCampusName(campusId);
const getCampusForPdf           = (campusId) => campusRepo.getCampusForPdf(campusId);
const getCampusStorageInfo      = (campusId) => campusRepo.getCampusStorageInfo(campusId);
const getCampusDefaults         = (campusId) => campusRepo.getCampusDefaults(campusId);
const getCampusNotificationContact = (campusId) => campusRepo.getCampusNotificationContact(campusId);
const getCampusNumber           = (campusId, opts) => campusRepo.getCampusNumber(campusId, opts);
const getCampusDocById          = (campusId) => campusRepo.getCampusDocById(campusId);
const getCampusCommissionConfig = (campusId) => campusRepo.getCampusCommissionConfig(campusId);
const getCampusCommissionConfigWithName = (campusId) => campusRepo.getCampusCommissionConfigWithName(campusId);
const setCampusCommissionConfig = (campusId, cfg) => campusRepo.setCampusCommissionConfig(campusId, cfg);
const getCampusAiEntitlement    = (campusId) => campusRepo.getCampusAiEntitlement(campusId);
const getCampusAiEntitlementWithAudit = (campusId) => campusRepo.getCampusAiEntitlementWithAudit(campusId);
const setCampusAiEntitlement    = (campusId, entitlement, auditEntry) =>
  campusRepo.setCampusAiEntitlement(campusId, entitlement, auditEntry);
const getCampusEntitlement      = (campusId) => campusRepo.getCampusEntitlement(campusId);
const getCampusEntitlementWithAudit = (campusId) => campusRepo.getCampusEntitlementWithAudit(campusId);
const listCampusEntitlements    = () => campusRepo.listCampusEntitlements();
const listCampusesForEstate     = () => campusRepo.listCampusesForEstate();
const setCampusEntitlement      = (campusId, entitlement, auditEntry) =>
  campusRepo.setCampusEntitlement(campusId, entitlement, auditEntry);
const getActiveCampusBySlug     = (slug, select) => campusRepo.getActiveCampusBySlug(slug, select);
const getActiveCampusById       = (campusId, select) => campusRepo.getActiveCampusById(campusId, select);
const listActivePublicCampuses  = (select) => campusRepo.listActivePublicCampuses(select);

module.exports = {
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
  listCampusEntitlements,
  listCampusesForEstate,
  getActiveCampusBySlug,
  getActiveCampusById,
  listActivePublicCampuses,
};
