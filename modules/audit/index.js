'use strict';

/** @file index.js @description Shared journal facade; no HTTP surface until consultation delivery. */
module.exports = Object.freeze({
  routes: null,
  service: Object.freeze(require('./audit.service')),
  constants: require('./audit.constants'),
});
