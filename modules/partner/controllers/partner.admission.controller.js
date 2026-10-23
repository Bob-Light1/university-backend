'use strict';

/** @file partner.admission.controller.js @description Management dossier preparation, configuration and private file streaming. */
const service = require('../admission.service');
const access = require('../admission.access.service');
const { admissionHandler } = require('../../../shared/utils/admission-response');
const { sendSuccess } = require('../../../shared/utils/response-helpers');
const { buildCampusFilter, isValidObjectId } = require('../../../shared/utils/validation-helpers');
const { ATTACHMENT_CATEGORIES, ADMISSION_ERRORS: E, admissionError } = require('../../../shared/constants/admission.constants');

/** Resolve the route id and authenticated campus before any multipart allocation. */
const authorizeDossier = admissionHandler(async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) throw admissionError(E.INVALID, 'Invalid lead id');
  req.admissionScope = buildCampusFilter(req.user, req.query.campusId);
  await service.getDossier(req.params.id, req.admissionScope);
  next();
});

/** GET /partners/leads/:id/dossier — management-only private metadata. */
const getDossier = admissionHandler(async (req, res) => sendSuccess(res, 200, 'Admission dossier',
  await service.getDossier(req.params.id, req.admissionScope)));

/** POST /partners/leads/:id/dossier/files — bytes are parsed only after authorization. */
const uploadFile = admissionHandler(async (req, res) => sendSuccess(res, 201, 'Attachment uploaded', await service.uploadFile({
  id: req.params.id, campusFilter: req.admissionScope, actor: req.user.id,
  revision: req.body.revision, category: req.body.category, file: req.file,
})));

/** GET /partners/leads/:id/dossier/files/:fileId — forced private download. */
const downloadFile = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.fileId)) throw admissionError(E.INVALID, 'Invalid attachment id');
  const file = await service.getFile(req.params.id, req.params.fileId, req.admissionScope);
  res.setHeader('Cache-Control', 'private, no-store');
  return require('../../document').service.streamAdmissionFile(file, res);
});

/** DELETE /partners/leads/:id/dossier/files/:fileId — archive draft metadata. */
const archiveFile = admissionHandler(async (req, res) => {
  if (!isValidObjectId(req.params.fileId)) throw admissionError(E.INVALID, 'Invalid attachment id');
  return sendSuccess(res, 200, 'Attachment archived', await service.archiveFile({
    id: req.params.id, fileId: req.params.fileId, campusFilter: req.admissionScope,
    revision: req.body.revision, actor: req.user.id,
  }));
});

/** POST /partners/leads/:id/dossier/access — send to the immutable stored contact only. */
const issueAccess = admissionHandler(async (req, res) => sendSuccess(res, 200, 'Dossier access delivery',
  await access.issueAccess(req.params.id, req.admissionScope)));

/** DELETE /partners/leads/:id/dossier/access — revoke the limited candidate capability. */
const revokeAccess = admissionHandler(async (req, res) => {
  await access.revokeAccess(req.params.id, req.admissionScope);
  return sendSuccess(res, 200, 'Dossier access revoked');
});

/** The global operator must select a campus; scoped operators cannot choose another one. */
function configCampus(req) {
  const scope = buildCampusFilter(req.user, req.query.campusId);
  if (!isValidObjectId(scope.schoolCampus)) throw admissionError(E.INVALID, 'Select a valid campus');
  return scope.schoolCampus;
}

/** GET /partners/admission/config — campus requirement categories. */
const getConfig = admissionHandler(async (req, res) => sendSuccess(res, 200, 'Admission requirements', {
  ...(await require('../../campus').service.getAdmissionConfig(configCampus(req))), categories: ATTACHMENT_CATEGORIES,
}));

/** PUT /partners/admission/config — submitted dossiers keep their requirement snapshot. */
const updateConfig = admissionHandler(async (req, res) => {
  const { requirements } = req.body;
  if (!Array.isArray(requirements) || requirements.length > ATTACHMENT_CATEGORIES.length
    || requirements.some((category) => !ATTACHMENT_CATEGORIES.includes(category)) || new Set(requirements).size !== requirements.length) {
    throw admissionError(E.INVALID, 'Requirements must contain unique supported categories');
  }
  const config = await require('../../campus').service.setAdmissionConfig(configCampus(req), requirements);
  if (!config) throw admissionError(E.NOT_FOUND, 'Campus not found', 404);
  return sendSuccess(res, 200, 'Admission requirements updated', config);
});

module.exports = { authorizeDossier, getDossier, uploadFile, downloadFile, archiveFile, issueAccess, revokeAccess, getConfig, updateConfig };
