'use strict';

/**
 * @file index.js — FACADE of the ai module (Phase 3 gateway, ADR-2).
 * Sole public entry point of the module — same invariant as the 23 other modules.
 *
 * No Mongoose model here (like academic-print before Phase 2): persistence
 * lives in ai-service (PostgreSQL + pgvector). The per-campus entitlement is
 * Campus data, accessed through the campus facade.
 */

const routes = require('./ai.routes');
const internalRoutes = require('./ai.internal.routes');
const service = require('./ai.service');

module.exports = {
  routes,          // mounted by app.js : app.use('/api/ai', ai.routes)
  service,         // inter-module API  : require('../ai').service.isEnabled() / forward()
  internalRoutes,  // mounted by app.js : app.use('/internal/ai', ai.internalRoutes)
                   // — S2S only, never published by the reverse proxy (§4.2)
};
