'use strict';

/** @file admission.repository.js @description Session-aware dossier, capability and attachment persistence. */
const mongoose = require('mongoose');
const Lead = require('./models/partner.lead.model');
const Attachment = require('./models/admission.attachment.model');
const { notDeletedFilter, softDeletePatch } = require('../../shared/utils/soft-delete');

/** Resolve a scoped lead, optionally inside a business transaction. */
const findLead = (filter, { session } = {}) => Lead.findOne({ honeypotTripped: false, ...filter })
  .session(session ?? null).lean();

/** Resolve only a live limited-access capability; never fall back to contact identity. */
const findCapability = (hash) => Lead.findOne({
  dossierAccessHash: hash, dossierAccessExpiresAt: { $gt: new Date() }, honeypotTripped: false,
  status: { $nin: ['rejected', 'abandoned'] },
}).lean();

/** Match absent legacy revisions as zero without updating historical records eagerly. */
const revisionFilter = (revision) => revision === 0
  ? { $or: [{ 'dossier.revision': 0 }, { 'dossier.revision': { $exists: false } }] }
  : { 'dossier.revision': revision };

/** Conditional mutation shared by preparation, submission, admission and enrollment. */
const mutateLead = (lead, revision, patch, history, session) => Lead.findOneAndUpdate({
  _id: lead._id, schoolCampus: lead.schoolCampus, status: lead.status, ...revisionFilter(revision),
}, {
  $set: patch, $inc: { 'dossier.revision': 1 }, ...(history && { $push: { statusHistory: history } }),
}, { new: true, runValidators: true, session }).lean();

/** Rotate or revoke access without changing the business dossier revision. */
const setCapability = (filter, patch, session) => Lead.updateOne(filter, { $set: patch }, { session });

/** Private file metadata is never included in partner self-service projections. */
const listAttachments = (lead, { session, archived = false } = {}) => Attachment.find({
  lead: lead._id, schoolCampus: lead.schoolCampus, ...(!archived && notDeletedFilter(Attachment)),
}).select('-fileName').sort({ createdAt: 1 }).session(session ?? null).lean();

/** Resolve a file by both lead and campus before returning its private storage name. */
const findAttachment = (id, lead, { session } = {}) => Attachment.findOne({
  _id: id, lead: lead._id, schoolCampus: lead.schoolCampus, ...notDeletedFilter(Attachment),
}).select('+fileName').session(session ?? null).lean();

/** Persist a normalized uploaded object within the transaction that charges its quota. */
const createAttachment = async (data, session) => (await Attachment.create([data], { session }))[0].toObject();

/** Archive metadata; the stored object is retained and still charged until guarded deletion. */
const archiveAttachment = (id, lead, actor, session) => Attachment.findOneAndUpdate({
  _id: id, lead: lead._id, schoolCampus: lead.schoolCampus, ...notDeletedFilter(Attachment),
}, { $set: { ...softDeletePatch(Attachment), deletedBy: actor } }, { new: true, session }).lean();

/** Count retained bytes, including archived objects that still exist in storage. */
async function getStorageBytes(campusId, { session } = {}) {
  const rows = await Attachment.aggregate([
    { $match: { schoolCampus: new mongoose.Types.ObjectId(String(campusId)) } },
    { $group: { _id: null, total: { $sum: '$sizeBytes' } } },
  ]).session(session ?? null);
  return rows[0]?.total || 0;
}

module.exports = {
  findLead, findCapability, mutateLead, setCapability, listAttachments, findAttachment,
  createAttachment, archiveAttachment, getStorageBytes,
};
