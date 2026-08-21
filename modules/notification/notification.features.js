'use strict';

/**
 * @file notification.features.js
 * @description Which module each notification template speaks FOR — the map
 * behind §9.4 of `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md`: no emission,
 * in-app or email, for a module that is not active on the recipient's campus.
 *
 * The notification foundation is the one door every emitter goes through
 * (`notify()`), which makes it the right place to enforce the rule once instead
 * of at each of the seven call sites. But the foundation deliberately knows
 * nothing about the modules it serves — it never queries their models and takes
 * the recipient's contact details from the caller (facade §3). The only thing
 * it holds that identifies the sender is the TEMPLATE KEY, so the attribution
 * is declared here rather than inferred.
 *
 * `null` means "attributable to no module" and is never suppressed. That is the
 * honest answer for `generic`, the pass-through used for ad hoc broadcasts: its
 * content is written by the caller, so nothing in it says which module it came
 * from, and guessing would silence a campus-wide announcement.
 *
 * `tests/unit/entitlement.jobs.test.js` pins this map against the real catalog:
 * a template added without an owner fails the suite rather than shipping
 * ungoverned, and an owner that is not a registry key fails too.
 */

const { FEATURE_KEYS } = require('../../shared/constants/features.constants');

/**
 * Template key → the feature whose activation governs it.
 *
 * The two `account.*` rows are not decoration: `account` is a core module, so
 * they resolve to "always allowed" by construction. Declaring them keeps the
 * coverage test able to tell a deliberate core attribution from a forgotten
 * one — which is exactly the difference that matters when the template being
 * suppressed is the activation email nobody can sign in without.
 */
const TEMPLATE_FEATURES = Object.freeze({
  generic:            null,          // caller-authored content — attributable to nothing
  'account.welcome':  'account',     // core
  'account.activate': 'account',     // core
  'result.published': 'result',
  'exam.graded':      'exam',
  'fraud.alert':      'partner',
  'payment.reminder': 'finance',
});

/**
 * @param {string} template
 * @returns {string|null} the governing feature, or null when the template is
 *   attributable to no module — including an UNDECLARED one, which must send
 *   rather than be silently dropped (§4.3).
 */
const featureOfTemplate = (template) =>
  (Object.prototype.hasOwnProperty.call(TEMPLATE_FEATURES, template)
    ? TEMPLATE_FEATURES[template]
    : null);

/** Declared owners that are real registry keys — used by the coverage test. */
const DECLARED_FEATURES = Object.freeze(
  [...new Set(Object.values(TEMPLATE_FEATURES).filter(Boolean))].filter((key) => FEATURE_KEYS.includes(key))
);

module.exports = { TEMPLATE_FEATURES, featureOfTemplate, DECLARED_FEATURES };
