'use strict';

/** @file admission.service.js @description Scoped dossier preparation, immutable submission and guarded decisions. */
const repo = require('./admission.repository');
const { transaction, requireLead, revisionOf, assertDraft, requireMutation, history } = require('./admission.helper');
const {
  LEAD_STATUS: S, TRANSITIONS, ATTACHMENT_CATEGORIES, ADMISSION_ROLES, MANAGEMENT_ROLES,
  DOSSIER_LIMITS, ADMISSION_ERRORS: E, admissionError,
} = require('../../shared/constants/admission.constants');
const { resolveQuota } = require('../../shared/utils/entitlement');

/** Read only the dossier projection appropriate for management or its candidate. */
async function getDossier(id, campusFilter = {}, candidate = false) {
  const lead = await requireLead(id, campusFilter);
  const [allFiles, config] = await Promise.all([
    repo.listAttachments(lead, { archived: !candidate }), require('../campus').service.getAdmissionConfig(lead.schoolCampus),
  ]);
  const attachments = allFiles.filter((file) => !file.deletedAt).map((file) => candidate ? {
    _id: file._id, category: file.category, originalName: file.originalName,
    mimeType: file.mimeType, sizeBytes: file.sizeBytes, createdAt: file.createdAt,
  } : file);
  return {
    lead: candidate ? {
      _id: lead._id, firstName: lead.firstName, lastName: lead.lastName,
      programInterest: lead.programInterest, status: lead.status, dossier: lead.dossier || { revision: 0 },
    } : lead,
    attachments,
    ...(!candidate && { archivedAttachments: allFiles.filter((file) => file.deletedAt) }),
    requirements: lead.dossier?.submittedAt ? lead.dossier.requiredCategories : (config?.admissionRequirements || []),
    categories: ATTACHMENT_CATEGORIES, limits: DOSSIER_LIMITS,
    historicalEnrollment: lead.status === S.ENROLLED && !lead.student,
  };
}

/** Archive a draft file without deleting its accepted business bytes. */
async function archiveFile({ id, fileId, campusFilter, revision, actor }) {
  return transaction(async (session) => {
    const lead = await requireLead(id, campusFilter, session);
    assertDraft(lead);
    const updated = requireMutation(await repo.mutateLead(lead, revisionOf(revision), {}, null, session));
    const archived = await repo.archiveAttachment(fileId, lead, String(actor), session);
    if (!archived) throw admissionError(E.NOT_FOUND, 'Attachment not found', 404);
    return { lead: updated, attachment: archived };
  });
}

/** Save normalized bytes, then atomically enforce revision, live-file limit and combined campus quota. */
async function uploadFile({ id, campusFilter, revision, actor, category, file }) {
  if (!ATTACHMENT_CATEGORIES.includes(category)) throw admissionError(E.INVALID, 'Invalid attachment category');
  const initial = await requireLead(id, campusFilter);
  assertDraft(initial);
  const documents = require('../document').service;
  const stored = await documents.saveAdmissionFile(file, initial.schoolCampus);
  let committed = false;
  try {
    const result = await transaction(async (session) => {
      const lead = await requireLead(id, campusFilter, session);
      assertDraft(lead);
      const campus = await require('../campus').service.lockAdmissionCampus(lead.schoolCampus, session);
      if (!campus) throw admissionError(E.NOT_FOUND, 'Campus not found', 404);
      const files = await repo.listAttachments(lead, { session });
      if (files.length >= DOSSIER_LIMITS.maxFiles) throw admissionError(E.QUOTA, 'The dossier file limit is reached', 409);
      const admissionBytes = await repo.getStorageBytes(lead.schoolCampus, { session });
      const gedBytes = await documents.getImportedStorageBytes(lead.schoolCampus, { session });
      if (admissionBytes + gedBytes + stored.sizeBytes > resolveQuota(campus, 'maxDocumentStorageMB') * 1024 * 1024) {
        throw admissionError(E.QUOTA, 'The campus storage quota is exhausted', 409);
      }
      const updated = requireMutation(await repo.mutateLead(lead, revisionOf(revision), {}, null, session));
      const attachment = await repo.createAttachment({
        schoolCampus: lead.schoolCampus, lead: lead._id, category, fileName: stored.fileName,
        originalName: stored.originalName, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes,
        uploadedBy: String(actor),
      }, session);
      delete attachment.fileName;
      return { lead: updated, attachment };
    });
    committed = true;
    documents.invalidateStorageCache(initial.schoolCampus);
    return result;
  } finally {
    if (!committed) await documents.discardAdmissionFile(initial.schoolCampus, stored.fileName);
  }
}

/** Resolve an authorized file's private reference for the HTTP streaming layer. */
async function getFile(id, fileId, campusFilter) {
  const lead = await requireLead(id, campusFilter);
  const file = await repo.findAttachment(fileId, lead);
  if (!file) throw admissionError(E.NOT_FOUND, 'Attachment not found', 404);
  return file;
}

/** Submit, decide or enroll through one endpoint; no legacy status route can bypass this service. */
async function transition({ id, campusFilter = {}, actor, status, revision, student, tuitionFee, note, candidate = false }) {
  if (!candidate && !MANAGEMENT_ROLES.includes(actor.role)) throw admissionError(E.FORBIDDEN, 'Management access is required', 403);
  if (candidate && status !== S.SUBMITTED) throw admissionError(E.FORBIDDEN, 'Candidate access permits submission only', 403);
  if (status === S.ADMITTED && !ADMISSION_ROLES.includes(actor.role)) throw admissionError(E.FORBIDDEN, 'Only a director or administrator can pronounce admission', 403);
  if (note != null && (typeof note !== 'string' || note.length > 1000)) throw admissionError(E.INVALID, 'The note must contain at most 1000 characters');
  return transaction(async (session) => {
    const lead = await requireLead(id, campusFilter, session);
    if (status === S.ENROLLED && lead.status === S.ENROLLED) {
      if (!lead.student) throw admissionError(E.HISTORICAL, 'This historical enrollment requires explicit reconciliation', 409);
      return { lead, student: { _id: lead.student }, alreadyEnrolled: true, activationReissueRequired: true, delivery: [] };
    }
    if (!TRANSITIONS[lead.status]?.includes(status)) throw admissionError(E.CONFLICT, 'Invalid lead status transition', 409);
    const expected = revisionOf(revision);
    if ((lead.dossier?.revision || 0) !== expected) throw admissionError(E.CONFLICT, 'The dossier changed; reload it', 409);
    if (status === S.ENROLLED) return require('./admission.enrollment.service').enroll({
      lead, revision: expected, actor, student, tuitionFee, note, session,
    });
    const patch = { status };
    if (status === S.SUBMITTED) {
      const campus = await require('../campus').service.lockAdmissionCampus(lead.schoolCampus, session);
      if (!campus) throw admissionError(E.NOT_FOUND, 'Campus not found', 404);
      const attachments = await repo.listAttachments(lead, { session });
      const required = campus.admissionRequirements || [];
      if (required.some((category) => !attachments.some((file) => file.category === category))) {
        throw admissionError(E.INCOMPLETE, 'Required dossier attachments are missing', 409);
      }
      patch['dossier.submittedAt'] = new Date();
      patch['dossier.requiredCategories'] = required;
      patch['dossier.attachmentIds'] = attachments.map((file) => file._id);
    }
    const updated = requireMutation(await repo.mutateLead(lead, expected, patch, history(status, actor.id, note?.trim() || null), session));
    let delivery = [];
    if (status === S.ADMITTED) delivery = await require('../notification').service.notify({
      recipient: { id: lead._id, model: 'PartnerLead', email: lead.email, campusId: lead.schoolCampus },
      template: 'admission.admitted', channels: ['email'], locale: lead.preferredLanguage,
      data: { name: lead.firstName }, groupKey: `admission:admitted:${lead._id}`, session,
    });
    return { lead: updated, delivery: delivery.map(({ _id, channel, status: deliveryStatus }) => ({ id: _id, channel, status: deliveryStatus })) };
  });
}

module.exports = { getDossier, getFile, uploadFile, archiveFile, transition, getStorageBytes: repo.getStorageBytes };
