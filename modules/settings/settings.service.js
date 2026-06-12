/**
 * @file settings.service.js
 * API publique du module settings (préférences utilisateur, timezones).
 */

const SUPPORTED_TIMEZONES = require('./models/timezone-whitelist');

module.exports = {
  // Liste blanche des timezones supportées (consommée par campus.controller
  // pour valider PATCH /api/campus/:id/defaults).
  SUPPORTED_TIMEZONES,
};
