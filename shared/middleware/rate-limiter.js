const rateLimit          = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * @file rate-limiter.js
 * @description Application-wide rate limiters.
 *
 * Distributed counters (REDIS_URL)
 * ─────────────────────────────────────────────────────────────────────────────
 * express-rate-limit's default MemoryStore keeps counters per process. Behind a
 * load balancer each instance then keeps its own tally, so the effective limit
 * becomes N× the configured value and per-IP burst/fraud detection is blind
 * across instances. When REDIS_URL is set we back every limiter with a shared
 * Redis store so each window is global; without it we fall back to the in-memory
 * store (dev / single instance). Same REDIS_URL switch as
 * modules/gaet/gaet.queue.js — a deployment concern, no call-site change.
 *
 * Each limiter MUST use its own store prefix; a shared prefix would merge
 * unrelated buckets (e.g. login and uploads) into a single counter.
 */

let redisClient = null;

/**
 * Builds the store for a limiter. Returns a Redis-backed store when REDIS_URL is
 * configured, otherwise `undefined` so express-rate-limit uses its MemoryStore.
 * @param {string} prefix - Unique key namespace for this limiter.
 * @returns {import('express-rate-limit').Store|undefined}
 */
let makeStore = () => undefined;

if (process.env.REDIS_URL) {
  const IORedis        = require('ioredis');
  const { RedisStore } = require('rate-limit-redis');

  redisClient = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  redisClient.on('error', (err) => console.error('[rate-limit] Redis error:', err.message));

  makeStore = (prefix) => new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix:      `rl:${prefix}:`,
  });

  console.log('✅ [rate-limit] Distributed store: Redis (shared across instances).');
} else {
  console.log('ℹ️  [rate-limit] Store: in-memory (per process). Set REDIS_URL for multi-instance.');
}

/**
 * Rate limiter for login attempts
 * 10 attempts per 15 minutes
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: makeStore('login'),
  // ipKeyGenerator normalizes IPv6 to prevent bypass (required by express-rate-limit v7+)
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Please try again in 15 minutes.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  },
  skipSuccessfulRequests: false,
  skipFailedRequests: false
});

/**
 * Rate limiter for general API requests
 * 100 requests per 15 minutes
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  store: makeStore('api'),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests from this IP. Please try again later.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Strict rate limiter for sensitive operations
 * 3 attempts per hour (account creation, password reset, etc.)
 */
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  store: makeStore('strict'),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many attempts. Please try again in 1 hour.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Rate limiter for file uploads
 * 10 uploads per hour
 */
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: makeStore('upload'),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many file uploads. Please try again later.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  },
  skip: (req) => req.fileTooLarge === true
});

// Fallback prefix counter for custom limiters declared without an explicit one.
// Deterministic by declaration order, so the same bucket is shared across
// instances — but prefer an explicit options.prefix for robustness across deploys.
let customSeq = 0;

/**
 * Factory: customizable rate limiter
 * @param {number} windowMinutes  - Time window in minutes
 * @param {number} maxRequests    - Maximum number of requests
 * @param {string} [customMessage]
 * @param {Object} [options]
 * @param {Function} [options.keyGenerator] - Custom key generator (req) => string.
 *   Defaults to per-IP keying off req.ip. Public-portal routes override this to
 *   key off the real visitor IP forwarded by the portal (req.portalClientIp).
 * @param {Function} [options.skip] - Predicate (req) => boolean; when it returns
 *   true the request is not counted. Public-portal read limiters use this to skip
 *   server-side rendering calls (no forwarded client IP), which would otherwise
 *   share the portal egress IP and throttle the whole site.
 * @param {string} [options.prefix] - Distinct Redis key namespace for this
 *   limiter. Required in practice when REDIS_URL is set so independent limiters
 *   do not share a counter; defaults to an order-based prefix otherwise.
 */
const createCustomLimiter = (windowMinutes, maxRequests, customMessage = null, options = {}) => {
  const prefix = options.prefix || `custom:${customSeq++}`;
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    store: makeStore(prefix),
    keyGenerator: options.keyGenerator || ((req) => ipKeyGenerator(req.ip)),
    ...(options.skip ? { skip: options.skip } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        message: customMessage || `Too many requests. Maximum ${maxRequests} requests per ${windowMinutes} minutes.`,
        retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
      });
    }
  });
};

/**
 * Closes the shared Redis connection used by the limiters (graceful shutdown).
 * No-op when running on the in-memory store.
 * @returns {Promise<void>}
 */
const shutdownRateLimiter = async () => {
  if (redisClient) redisClient.disconnect();
};

module.exports = {
  loginLimiter,
  apiLimiter,
  strictLimiter,
  uploadLimiter,
  createCustomLimiter,
  shutdownRateLimiter
};
