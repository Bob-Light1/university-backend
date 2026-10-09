'use strict';
/** @file session.constants.js
 * @description Canonical authentication policy and public error vocabulary.
 */
module.exports = Object.freeze({
  ISSUER: 'school-management-app',
  ACCESS_SECONDS: 15 * 60,
  SESSION_MS: 7 * 24 * 60 * 60 * 1000,
  LOCK_MS: 15 * 60 * 1000,
  MAX_FAILURES: 5,
  MAX_ROTATIONS: 1000,
  COOKIE: 'erp_refresh',
  COOKIE_PATH: '/api/account/session',
  HEADER: 'X-Requested-With',
  HEADER_VALUE: 'ERP',
  ERRORS: Object.freeze({ EXPIRED: 'AUTH_ACCESS_EXPIRED', INVALID: 'AUTH_SESSION_INVALID' }),
  ROLE_MODELS: Object.freeze({
    ADMIN: 'Admin', DIRECTOR: 'Admin', CAMPUS_MANAGER: 'Campus',
    STUDENT: 'Student', TEACHER: 'Teacher', PARENT: 'Parent',
    MENTOR: 'Mentor', STAFF: 'Staff', PARTNER: 'Partner',
  }),
});
