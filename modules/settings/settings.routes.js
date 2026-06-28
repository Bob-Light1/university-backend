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

// All settings routes require authentication
router.use(authenticate);

// Named routes before '/' (Express conflict prevention).
router.get('/language', getLanguage);
router.get('/options',  getOptions);
router.get('/',         getSettings);
router.patch('/',       updateSettings);
router.post('/',        upsertSettings);

module.exports = router;
