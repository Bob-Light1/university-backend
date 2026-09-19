'use strict';

/**
 * @file brand.config.js
 * @description Deployment product identity; establishment identity remains separate.
 */

/** Resolve on use so deployment configuration and isolated tests share one rule. */
function getProductName() {
  return String(process.env.PRODUCT_BRAND_NAME || '').trim() || 'Wewigo';
}

/** Preserve existing institutional notification identity before the product fallback. */
function getPortalBrandName() {
  return String(process.env.BRAND_NAME || '').trim()
    || String(process.env.NEXT_PUBLIC_BRAND_NAME || '').trim()
    || getProductName();
}

module.exports = { getProductName, getPortalBrandName };
