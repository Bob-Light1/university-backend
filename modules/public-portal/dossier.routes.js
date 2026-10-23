'use strict';

/** @file dossier.routes.js @description Public-portal-key protected candidate capabilities and bounded private uploads. */
const express = require('express');
const { ipKeyGenerator } = require('express-rate-limit');
const { createCustomLimiter } = require('../../shared/middleware/rate-limiter');
const upload = require('../../shared/middleware/admission-upload');
const ctrl = require('./controllers/public/public.dossier.controller');
const router = express.Router();
const keyGenerator = (req) => ipKeyGenerator(req.portalClientIp || req.ip);
const recoveryLimiter = createCustomLimiter(60, 5, 'Too many dossier access requests.', { keyGenerator, prefix: 'dossier:recovery' });
const mutationLimiter = createCustomLimiter(60, 30, 'Too many dossier mutations.', { keyGenerator, prefix: 'dossier:write' });

/** @route POST /api/public/admission/request-access @desc Uniform private-link recovery @access PUBLIC */
router.post('/request-access', recoveryLimiter, ctrl.requestAccess);
router.use(ctrl.authenticate);
router.use((req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : mutationLimiter(req, res, next));
/** @route GET /api/public/admission/dossier @desc Own private dossier @access DOSSIER_CAPABILITY */
router.get('/dossier', ctrl.getDossier);
/** @route POST /api/public/admission/dossier/files @desc Own draft-file upload @access DOSSIER_CAPABILITY */
router.post('/dossier/files', upload, ctrl.uploadFile);
/** @route GET /api/public/admission/dossier/files/:fileId @desc Own private download @access DOSSIER_CAPABILITY */
router.get('/dossier/files/:fileId', ctrl.downloadFile);
/** @route DELETE /api/public/admission/dossier/files/:fileId @desc Archive own draft file @access DOSSIER_CAPABILITY */
router.delete('/dossier/files/:fileId', ctrl.archiveFile);
/** @route POST /api/public/admission/dossier/submit @desc Submit own complete dossier @access DOSSIER_CAPABILITY */
router.post('/dossier/submit', ctrl.submit);
module.exports = router;
