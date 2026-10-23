'use strict';

/** @file admission-storage.service.js @description Strict passive-file normalization and private applicant storage. */
const crypto = require('crypto');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, PDFDict, PDFArray, PDFName } = require('pdf-lib');
const storage = require('./document.storage.service');
const { DOSSIER_LIMITS, ADMISSION_ERRORS: E, admissionError } = require('../../../shared/constants/admission.constants');

const ACTIVE_KEYS = Object.freeze(['A', 'AA', 'OpenAction', 'JS', 'JavaScript', 'AcroForm', 'EmbeddedFiles', 'XFA', 'RichMediaContent', 'Collection']);

/** Recover UTF-8 multipart names decoded as Latin-1 without changing native names. */
function displayName(value) {
  let name = String(value);
  if (Array.from(name).every((character) => character.codePointAt(0) <= 255)) {
    const bytes = Buffer.from(name, 'latin1');
    const decoded = bytes.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(bytes)) name = decoded;
  }
  return path.basename(name)
    // eslint-disable-next-line no-control-regex -- Untrusted display names must not contain header control bytes.
    .replace(/[\x00-\x1f\x7f"\\]/g, '').slice(0, 200);
}

/** Reject active PDF dictionaries, including directly nested objects and stream dictionaries. */
function assertPassive(value, visited = new Set()) {
  if (!value || visited.has(value)) return;
  visited.add(value);
  const dict = value instanceof PDFDict ? value : value.dict;
  if (dict instanceof PDFDict) {
    if (ACTIVE_KEYS.some((key) => dict.has(PDFName.of(key)))) throw new Error('Active PDF content');
    for (const key of dict.keys()) assertPassive(dict.get(key), visited);
  } else if (value instanceof PDFArray) {
    for (let index = 0; index < value.size(); index += 1) assertPassive(value.get(index), visited);
  }
}

/** Validate actual bytes and normalize without ever falling back to an unprocessed upload. */
async function normalizeAdmissionFile(file) {
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > DOSSIER_LIMITS.maxFileBytes) {
    throw admissionError(E.FILE, 'A non-empty file of at most 5 MiB is required', 413);
  }
  let buffer;
  let extension;
  try {
    if (file.mimetype === 'application/pdf' && file.buffer.subarray(0, 5).toString() === '%PDF-') {
      const doc = await PDFDocument.load(file.buffer);
      if (!doc.getPageCount()) throw new Error('Empty PDF');
      const visited = new Set();
      for (const [, value] of doc.context.enumerateIndirectObjects()) assertPassive(value, visited);
      assertPassive(doc.catalog, visited);
      buffer = Buffer.from(await doc.save());
      extension = 'pdf';
    } else if (['image/png', 'image/jpeg'].includes(file.mimetype) && storage.validateMagicBytes(file.buffer, file.mimetype)) {
      const image = sharp(file.buffer, { limitInputPixels: 20_000_000, failOn: 'warning' }).rotate()
        .resize(3000, 3000, { fit: 'inside', withoutEnlargement: true });
      extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
      buffer = await (extension === 'png' ? image.png() : image.jpeg({ quality: 90 })).toBuffer();
    } else throw new Error('Unsupported content');
    if (buffer.length > DOSSIER_LIMITS.maxFileBytes) throw new Error('Normalized file too large');
  } catch {
    throw admissionError(E.FILE, 'Only readable passive PDF, PNG and JPEG files are accepted', 422);
  }
  return {
    buffer, mimeType: file.mimetype, extension,
    originalName: displayName(file.originalname || `attachment.${extension}`) || `attachment.${extension}`,
  };
}

/** Save already normalized bytes under a private campus-scoped UUID. */
async function saveAdmissionFile(file, campusId) {
  const normalized = await normalizeAdmissionFile(file);
  const fileName = `${crypto.randomUUID()}.${normalized.extension}`;
  const stored = await storage.saveBuffer(normalized.buffer, { campusId, category: 'admission', fileName, mimeType: normalized.mimeType });
  return { ...stored, originalName: normalized.originalName, mimeType: normalized.mimeType };
}

/** Stream only a previously authorized attachment; callers never supply a raw key. */
const streamAdmissionFile = (file, res) => storage.streamFile(file.schoolCampus, 'admission', file.fileName, res, {
  download: true, displayName: file.originalName, cacheControl: 'private, no-store',
});

/** Compensation for uncommitted uploads, or stored-file cleanup after a guarded permanent deletion. */
const discardAdmissionFile = async (campusId, fileName) => {
  const removed = await storage.deleteFile(campusId, 'admission', fileName);
  require('../middleware/document.campus.middleware').invalidateStorageCache(campusId);
  return removed;
};

module.exports = { normalizeAdmissionFile, saveAdmissionFile, streamAdmissionFile, discardAdmissionFile };
