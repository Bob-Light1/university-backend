const express = require('express');
const router  = express.Router();

const { authenticate } = require('../../shared/middleware/auth');
const {
  getSettings,
  updateSettings,
  upsertSettings,
  getLanguage,
} = require('./controllers/settings.controller');

// All settings routes require authentication
router.use(authenticate);

router.get('/language', getLanguage);
router.get('/',         getSettings);
router.patch('/',       updateSettings);
router.post('/',        upsertSettings);

module.exports = router;
