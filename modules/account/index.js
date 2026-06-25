'use strict';

/**
 * @file index.js — FACADE of the account-activation module.
 *
 * Public surface (CLAUDE.md §1):
 *   - routes  : mounted by app.js          → app.use('/api/account', account.routes)
 *   - service : inter-module API           → require('../account').service.issueActivationToken({ ... })
 *
 * NO model is exported. Other modules never touch ActivationToken directly.
 */

const routes  = require('./account.routes');
const service = require('./account.service');

module.exports = {
  routes,
  service,
};
