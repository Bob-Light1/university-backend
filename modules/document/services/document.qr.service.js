'use strict';

/**
 * @file document.qr.service.js
 * @description QR code generation for document verification.
 *
 * QR codes encode the public verification URL:
 *   https://{QR_VERIFICATION_BASE_URL}/verify/{doc.ref}
 *
 * doc.ref format: DOC-{YEAR}-{CAMPUS_CODE}-{nanoid(8)}
 * → The nanoid suffix provides ~281 trillion combinations — immune to sequential scanning.
 *
 * QR codes are never stored. They are regenerated from `doc.ref` at render time and
 * inlined as data: URIs — the payload is the verification URL and nothing else, so a
 * stored PNG could only ever be a stale copy of a pure function of the reference.
 *
 * A `generateQrCode()` that wrote a PNG under `uploads/documents/{campusId}/qrcodes/`
 * used to live here. It had ZERO callers, wrote straight to the filesystem behind the
 * storage service's back, and was the last thing keeping `qrcodes/` alive as a write
 * target. Deletion of legacy `qrCode.fileName` rows is still handled by
 * `document.service.collectOwnedFiles`, so nothing is orphaned.
 *
 * The verification endpoint (GET /api/documents/verify/:ref) is public and rate-limited.
 * It returns minimal metadata only — never document content or internal IDs.
 */

const QRCode = require('qrcode');

const BASE_URL = process.env.QR_VERIFICATION_BASE_URL || 'https://app.yourdomain.com';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a QR code as a base64 data URL, for inline embedding in HTML templates.
 * Writes nothing, anywhere.
 *
 * @param {string} docRef
 * @param {number} size
 * @returns {Promise<string>} Base64 data URL
 */
const generateQrCodeDataUrl = async (docRef, size = 80) => {
  const verificationUrl = `${BASE_URL}/verify/${docRef}`;

  return QRCode.toDataURL(verificationUrl, {
    type:                 'image/png',
    width:                size,
    errorCorrectionLevel: 'M',
    margin:               2,
  });
};

module.exports = {
  generateQrCodeDataUrl,
};