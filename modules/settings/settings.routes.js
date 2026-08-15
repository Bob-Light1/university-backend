const express = require('express');
const router  = express.Router();

const { authenticate } = require('../../shared/middleware/auth');
const {
  getSettings,
  updateSettings,
  upsertSettings,
  getLanguage,
  getOptions,
} = require('./controllers/settings.controller');
const { getEntitlement } = require('./controllers/settings.entitlement.controller');

// All settings routes require authentication
router.use(authenticate);

// Named routes before '/' (Express conflict prevention).
router.get('/language', getLanguage);
router.get('/options',  getOptions);

/**
 * @route   GET /api/settings/entitlement
 * @desc    Effective per-campus feature states of the caller — hydrates the
 *          frontend EntitlementProvider (CAMPUS_ENTITLEMENT_DESIGN.md §8.1).
 * @access  Authenticated (any role)
 */
router.get('/entitlement', getEntitlement);
router.get('/',         getSettings);
router.patch('/',       updateSettings);
router.post('/',        upsertSettings);

module.exports = router;
