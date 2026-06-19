'use strict';

/**
 * Locale middleware — parses Accept-Language and attaches req.locale.
 *
 * Sets req.locale to the best supported language from the header,
 * falling back to 'en'. Useful for pre-login endpoints where no JWT
 * exists and error messages should match the client's language.
 *
 * Usage: app.use(localeMiddleware) in server.js, before all routes.
 */

const { normalize } = require('../i18n/languages');

/**
 * Parse Accept-Language header and return the best supported code.
 * Handles: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
 */
function parse(header) {
  if (!header) return null;

  const tags = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.trim(), q: q !== undefined ? parseFloat(q) : 1 };
    })
    .filter(({ tag, q }) => tag && !isNaN(q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    // normalize() handles « fr-FR » → « fr » and any « zh-* » variant → « zh-CN ».
    const code = normalize(tag);
    if (code) return code;
  }
  return null;
}

module.exports = function localeMiddleware(req, _res, next) {
  req.locale = parse(req.headers['accept-language']) || 'en';
  next();
};
