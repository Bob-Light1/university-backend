const express = require('express');
const router  = express.Router();

const { authenticate } = require('../middleware/auth/auth');
const {
  getSettings,
  updateSettings,
  upsertSettings,
  getLanguage,
} = require('../controllers/settings_controller');

// All settings routes require authentication
router.use(authenticate);

router.get('/language', getLanguage);
router.get('/',         getSettings);
router.patch('/',       updateSettings);
router.post('/',        upsertSettings);

module.exports = router;
