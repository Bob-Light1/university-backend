'use strict';

/** @file admission.enrollment.service.js @description Atomic pending-student, commission and delivery-intent creation. */
const partnerRepo = require('./partner.repository');
const repo = require('./admission.repository');
const { requireMutation, history } = require('./admission.helper');
const { ADMISSION_ERRORS: E, admissionError, LEAD_STATUS } = require('../../shared/constants/admission.constants');

/** Preserve existing partner-override/campus-default commission rules inside the transaction. */
async function createEnrollmentCommission(lead, tuitionFee, session) {
  if (!lead.partner) return null;
  const partner = await partnerRepo.findPartnerForCommission(lead.partner, { session });
  if (!partner || String(partner.schoolCampus) !== String(lead.schoolCampus)) {
    throw admissionError(E.CONFLICT, 'The referring partner is unavailable on this campus', 409);
  }
  const campus = await require('../campus').service.getCampusCommissionConfig(lead.schoolCampus);
  const config = partner.commissionConfig?.ruleType ? partner.commissionConfig : campus?.commissionConfig;
  const currency = config?.currency || config?.defaultCurrency || 'XAF';
  const amount = config?.ruleType === 'FIXED' ? (config.fixedAmount || 0)
    : config?.ruleType === 'PERCENTAGE' && tuitionFee > 0 ? Math.round(config.percentage / 100 * tuitionFee) : 0;
  return partnerRepo.createCommission({
    schoolCampus: lead.schoolCampus, partner: partner._id, lead: lead._id,
    amount, currency, status: 'pending', fraudFlags: lead.fraudFlags || [],
    ruleSnapshot: {
      ruleType: config?.ruleType || 'FIXED', fixedAmount: config?.fixedAmount || 0,
      percentage: config?.percentage || null, currency, tier: partner.tier || null,
    },
    ...(!config?.ruleType && { notes: 'No commission configuration; pending manual review.' }),
  }, { session });
}

/** Create all business records and activation/delivery intent, committing or rolling back together. */
async function enroll({ lead, revision, actor, student, tuitionFee, note, session }) {
  if (!student || typeof student !== 'object' || Array.isArray(student)) throw admissionError(E.INVALID, 'Student assignment is required');
  if (tuitionFee != null && (!Number.isFinite(Number(tuitionFee)) || Number(tuitionFee) < 0)) {
    throw admissionError(E.INVALID, 'The optional tuition basis must be a non-negative number');
  }
  const created = await require('../student').service.createPendingStudent({
    firstName: lead.firstName, lastName: lead.lastName, phone: lead.phone,
    ...student, email: lead.email,
  }, lead.schoolCampus, session);
  const commission = await createEnrollmentCommission(lead, Number(tuitionFee || 0), session);
  const updated = requireMutation(await repo.mutateLead(lead, revision, {
    status: LEAD_STATUS.ENROLLED, student: created._id,
    ...(commission && { commissionId: commission._id }),
  }, history(LEAD_STATUS.ENROLLED, actor.id, note), session));
  const activation = await require('../account').service.issueActivationToken({
    userModel: 'Student', userId: created._id, campusId: lead.schoolCampus, email: created.email,
    name: created.firstName, locale: lead.preferredLanguage, createdBy: actor.id, session,
  });
  const delivery = await require('../notification').service.notify({
    recipient: { id: lead._id, model: 'PartnerLead', campusId: lead.schoolCampus, email: lead.email },
    channels: ['email'], template: 'admission.enrolled', locale: lead.preferredLanguage,
    data: { name: created.firstName }, groupKey: `admission:enrolled:${lead._id}`, session,
  });
  return {
    lead: updated, student: created, commission, activation,
    delivery: [...activation.delivery, ...delivery.map(({ _id, channel, status }) => ({ id: _id, channel, status }))],
  };
}

module.exports = { enroll };
