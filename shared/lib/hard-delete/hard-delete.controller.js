'use strict';

/**
 * @file hard-delete.controller.js
 * @description HTTP surface of the danger zone: catalogue, impact preview, execution, ledger.
 *
 * The controller holds no deletion logic — every rule lives in hard-delete.service.js so the
 * per-module `/permanent` routes reach exactly the same guarantees when they delegate here.
 */

const {
  sendSuccess,
  sendError,
  sendPaginated,
  asyncHandler,
} = require('../../utils/response-helpers');

const hardDeleteService = require('./hard-delete.service');
const { listEntries }   = require('./hard-delete.registry');
const {
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  CONFIRMATION_VERB,
  TICKET_TTL_SECONDS,
} = require('./hard-delete.constants');

/**
 * Maps a service error onto its HTTP response, preserving any structured payload
 * (`blockers`) the service attached.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @returns {import('express').Response}
 */
const respondToError = (res, error) => {
  if (error.statusCode) {
    return sendError(res, error.statusCode, error.message, error.blockers ? { blockers: error.blockers } : undefined);
  }

  console.error('❌ hard-delete error:', error);
  return sendError(res, 500, 'Permanent deletion failed');
};

/**
 * Lists the entity types the caller may permanently delete, plus the confirmation policy the
 * frontend must enforce. Keeps the danger-zone UI from hard-coding backend rules.
 *
 * @route  GET /api/danger-zone/entities
 * @access ADMIN | DIRECTOR
 */
const getDeletableEntities = asyncHandler(async (req, res) => {
  return sendSuccess(res, 200, 'Deletable entities retrieved', {
    entities: listEntries(req.user.role),
    policy: {
      confirmationVerb:  CONFIRMATION_VERB,
      minReasonLength:   MIN_REASON_LENGTH,
      maxReasonLength:   MAX_REASON_LENGTH,
      ticketTtlSeconds:  TICKET_TTL_SECONDS,
      requiresPassword:  true,
    },
  });
});

/**
 * Read-only impact report for a candidate deletion. Mints the ticket required by the execute
 * endpoint — a deletion cannot be fired without first having been previewed.
 *
 * @route  GET /api/danger-zone/:entityType/:id/impact
 * @access ADMIN | DIRECTOR (narrowed per entity by the registry)
 */
const getDeletionImpact = asyncHandler(async (req, res) => {
  try {
    const report = await hardDeleteService.preview({
      entityType: req.params.entityType,
      entityId:   req.params.id,
      req,
    });

    return sendSuccess(res, 200, 'Deletion impact computed', report);
  } catch (error) {
    return respondToError(res, error);
  }
});

/**
 * Performs the permanent deletion. Requires, in the body: the ticket from the impact preview,
 * the exact confirmation phrase, the operator's password and a written justification.
 *
 * @route  DELETE /api/danger-zone/:entityType/:id
 * @access ADMIN | DIRECTOR (narrowed per entity by the registry)
 */
const executeHardDelete = asyncHandler(async (req, res) => {
  try {
    const receipt = await hardDeleteService.execute({
      entityType: req.params.entityType,
      entityId:   req.params.id,
      req,
      confirmation: {
        ticket:             req.body?.ticket,
        confirmationPhrase: req.body?.confirmationPhrase,
        password:           req.body?.password,
        reason:             req.body?.reason,
      },
    });

    return sendSuccess(res, 200, `${receipt.label} permanently deleted`, receipt);
  } catch (error) {
    return respondToError(res, error);
  }
});

/**
 * Paginated deletion ledger. Campus-scoped for non-global roles.
 *
 * @route  GET /api/danger-zone/history
 * @access ADMIN | DIRECTOR
 */
const getDeletionHistory = asyncHandler(async (req, res) => {
  try {
    const { entries, total, page, limit } = await hardDeleteService.listHistory({ req, query: req.query });

    return sendPaginated(res, 200, 'Deletion history retrieved', entries, { total, page, limit });
  } catch (error) {
    return respondToError(res, error);
  }
});

module.exports = {
  getDeletableEntities,
  getDeletionImpact,
  executeHardDelete,
  getDeletionHistory,
  respondToError,
};
