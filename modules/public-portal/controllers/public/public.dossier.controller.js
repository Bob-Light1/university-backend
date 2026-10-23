'use strict';

/** @file public.dossier.controller.js @description Candidate-only dossier operations behind a revocable capability. */
const { service: partner } = require('../../../partner');
const { resolvePortalCampus, portalState } = require('../../portal-campus');
const { admissionHandler } = require('../../../../shared/utils/admission-response');
const { sendSuccess } = require('../../../../shared/utils/response-helpers');
const { isValidEmail, isValidObjectId } = require('../../../../shared/utils/validation-helpers');
const { LEAD_STATUS, ADMISSION_ERRORS: E, admissionError } = require('../../../../shared/constants/admission.constants');

/** Recovery never reveals whether an email exists and never accepts a destination override. */
const requestAccess = admissionHandler(async (req, res) => {
  if (!isValidEmail(req.body.email) || typeof req.body.campusSlug !== 'string') throw admissionError(E.INVALID, 'Email and campus are required');
  const campus = await resolvePortalCampus(res, { slug: req.body.campusSlug.trim().toLowerCase(), write: true });
  if (!campus) return;
  try { await partner.admissionAccess.requestAccess(req.body.email, campus._id); } catch {
    // Delivery failure remains recoverable without revealing a candidate's existence.
  }
  return sendSuccess(res, 202, 'If a dossier exists, a private link will be sent to its registered address.');
});

/** Resolve the lead from the capability before allocating any multipart file buffer. */
const authenticate = admissionHandler(async (req, res, next) => {
  const header = req.get('Authorization') || '';
  const lead = await partner.admissionAccess.authenticate(header.startsWith('Dossier ') ? header.slice(8) : null);
  const campus = await resolvePortalCampus(res, { id: lead.schoolCampus, write: !['GET', 'HEAD'].includes(req.method) });
  if (!campus) return;
  req.dossierLead = lead;
  req.dossierScope = { schoolCampus: lead.schoolCampus };
  req.dossierReadOnly = await portalState(lead.schoolCampus) === 'read_only';
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

/** GET /public/admission/dossier — no internal notes, student assignment or storage keys. */
const getDossier = admissionHandler(async (req, res) => sendSuccess(res, 200, 'Admission dossier',
  { ...(await partner.admission.getDossier(req.dossierLead._id, req.dossierScope, true)), readOnly: req.dossierReadOnly }));

/** POST /public/admission/dossier/files — upload to the capability's lead only. */
const uploadFile = admissionHandler(async (req, res) => {
  await partner.admission.uploadFile({
    id: req.dossierLead._id, campusFilter: req.dossierScope, actor: `candidate:${req.dossierLead._id}`,
    revision: req.body.revision, category: req.body.category, file: req.file,
  });
  return getDossier(req, res);
});

/** GET /public/admission/dossier/files/:fileId — private forced download. */
const downloadFile = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.fileId)) throw admissionError(E.INVALID, 'Invalid attachment id');
  const file = await partner.admission.getFile(req.dossierLead._id, req.params.fileId, req.dossierScope);
  return require('../../../document').service.streamAdmissionFile(file, res);
});

/** DELETE /public/admission/dossier/files/:fileId — archive own draft file. */
const archiveFile = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.fileId)) throw admissionError(E.INVALID, 'Invalid attachment id');
  await partner.admission.archiveFile({
    id: req.dossierLead._id, fileId: req.params.fileId, campusFilter: req.dossierScope,
    revision: req.body.revision, actor: `candidate:${req.dossierLead._id}`,
  });
  return getDossier(req, res);
});

/** POST /public/admission/dossier/submit — no candidate-controlled target status. */
const submit = admissionHandler(async (req, res) => {
  await partner.admission.transition({
    id: req.dossierLead._id, campusFilter: req.dossierScope, actor: { id: `candidate:${req.dossierLead._id}` },
    status: LEAD_STATUS.SUBMITTED, revision: req.body.revision, candidate: true,
  });
  return getDossier(req, res);
});

module.exports = { requestAccess, authenticate, getDossier, uploadFile, downloadFile, archiveFile, submit };
