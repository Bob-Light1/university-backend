'use strict';

/**
 * @file storage-reference.schema.js
 * @description Mongoose fragment persisting what a deletion needs.
 *
 * Kept apart from `storage-reference.js` so a model can declare the field without
 * pulling in multer, Cloudinary and the upload middleware at schema-definition
 * time. The provider enum is declared here and re-exported by
 * `storage-reference.js`, so the two cannot drift.
 *
 * Why the field exists at all: `profileImage` holds a URL, and a URL is a way to
 * *read* an asset, not a handle to *manage* it. You cannot delete what you did
 * not record — which is why replacing a profile picture never removed the old
 * file, in any environment (B7-③).
 */

const STORAGE_PROVIDER = Object.freeze({
  CLOUDINARY: 'cloudinary',
  LOCAL:      'local',
  MEMORY:     'memory',
});

/**
 * Sub-document describing where an uploaded asset actually lives.
 * `null` on rows created before this field existed — see
 * `scripts/migrate-profile-image-ref.js` for which of those are recoverable.
 */
const storageRefSchema = {
  type: {
    provider:   { type: String, enum: Object.values(STORAGE_PROVIDER) },
    storageKey: { type: String },
  },
  default: null,
  _id:     false,
};

module.exports = { STORAGE_PROVIDER, storageRefSchema };
