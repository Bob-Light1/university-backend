'use strict';

/**
 * @file ai.routes.js
 * @description Public AI gateway routes (/api/ai/*, ADR-2). Same JWT, same
 * middlewares as every ERP route; on top of the global apiLimiter a dedicated
 * per-user limiter guards LLM cost (§6.1). Every route then passes the
 * per-campus entitlement gate (§11.3).
 *
 * Route matrix:
 *  POST /api/ai/chat               → chat              (all roles, feature 'chat', SSE)
 *  POST /api/ai/search             → search            (all roles, feature 'search')
 *  GET  /api/ai/conversations      → listConversations (all roles, feature 'chat')
 *  GET  /api/ai/conversations/:id  → getConversation   (all roles, feature 'chat')
 *  POST /api/ai/analytics/:report  → analytics         (staffing roles, feature 'analytics')
 *  POST /api/ai/advisors/:advisor  → advisors          (direction roles, feature 'advisors')
 *  GET  /api/ai/usage              → usage             (CAMPUS_MANAGER+, AI enabled)
 */

const express = require('express');
const { ipKeyGenerator } = require('express-rate-limit');

const { authenticate, authorize } = require('../../shared/middleware/auth');
const { createCustomLimiter } = require('../../shared/middleware/rate-limiter');
const config = require('../../shared/configs/general.config');
const { requireAiFeature } = require('./ai.entitlement.middleware');
const {
  chat,
  search,
  listConversations,
  getConversation,
  analytics,
  advisors,
  usage,
} = require('./ai.controller');

const router = express.Router();

router.use(authenticate);

// Cost guard: keyed per authenticated user (not per IP — campus networks
// share NATed egress IPs), window of 1 minute (§6.1, AI_RATE_LIMIT_PER_MIN).
const aiLimiter = createCustomLimiter(
  1,
  config.ai.rateLimitPerMin,
  'Too many AI requests. Please slow down.',
  {
    prefix: 'ai',
    keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  }
);
router.use(aiLimiter);

/**
 * @route   POST /api/ai/chat
 * @desc    Conversational assistant (RAG) — SSE streamed reply (Annexe B)
 * @access  All authenticated roles, campus feature 'chat'
 */
router.post('/chat', requireAiFeature('chat'), chat);

/**
 * @route   POST /api/ai/search
 * @desc    Semantic/hybrid internal search with verified citations
 * @access  All authenticated roles, campus feature 'search'
 */
router.post('/search', requireAiFeature('search'), search);

/**
 * @route   GET /api/ai/usage
 * @desc    Monthly AI consumption gauge of the campus (plan, budget, remaining)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER
 * @note    Declared before /conversations/:id — named routes first (§7).
 */
router.get(
  '/usage',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  requireAiFeature(null),
  usage
);

/**
 * @route   GET /api/ai/conversations
 * @desc    Paginated chat history of the current user (stored in ai-service)
 * @access  All authenticated roles, campus feature 'chat'
 */
router.get('/conversations', requireAiFeature('chat'), listConversations);

/**
 * @route   GET /api/ai/conversations/:id
 * @desc    One conversation with its messages and citations
 * @access  All authenticated roles, campus feature 'chat' (ownership enforced by ai-service)
 */
router.get('/conversations/:id', requireAiFeature('chat'), getConversation);

/**
 * @route   POST /api/ai/analytics/:report
 * @desc    AI-assisted descriptive summary over ERP aggregates (Feature 2, M5)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER, STAFF, TEACHER — campus feature 'analytics'
 */
router.post(
  '/analytics/:report',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER', 'STAFF', 'TEACHER']),
  requireAiFeature('analytics'),
  analytics
);

/**
 * @route   POST /api/ai/advisors/:advisor
 * @desc    Business advisor proposals (engine + LLM, human-in-the-loop, M5b)
 * @access  ADMIN, DIRECTOR, CAMPUS_MANAGER — campus feature 'advisors' (D9)
 */
router.post(
  '/advisors/:advisor',
  authorize(['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER']),
  requireAiFeature('advisors'),
  advisors
);

module.exports = router;
