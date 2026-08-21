'use strict';

/**
 * @file content.builder.js
 * @description GED documents and announcements — the two models whose deletion
 * marker is `deletedAt` alone, and the two the fixture exists to disambiguate.
 *
 * Both traps of §4.3 live here:
 *
 *   - a soft-deleted document KEEPS `status: 'PUBLISHED'`. Only `deletedAt` says
 *     it is gone, so `{ status: 'PUBLISHED' }` returns deleted documents;
 *   - an announcement in `status: 'archived'` is LIVE — that is the expiry state
 *     written by the nightly cron. Filtering announcements on
 *     `{ status: { $ne: 'archived' } }` is wrong in both directions at once:
 *     it hides live rows and returns deleted ones (CLAUDE.md §5.1).
 */

const { oid, pad, stamps } = require('../ids');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR } = require('../seed.config');

const DOC_TYPES = ['STUDENT_TRANSCRIPT', 'CLASS_LIST', 'ADMINISTRATIVE', 'REPORT', 'STUDENT_ID_CARD'];
const DOC_CATEGORIES = ['ACADEMIC', 'ADMINISTRATIVE', 'IDENTITY', 'COMMUNICATION', 'FINANCIAL'];

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildDocuments = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];
  const students = ctx.students[campusKey];

  return Array.from({ length: counts.documents }, (_, i) => {
    const n = pad(i + 1);
    const deleted = i + 1 > counts.documents - counts.documentsDeleted;
    const student = students[i % students.length];

    return {
      _id: oid(`document:${campusKey}:${n}`),
      ref: `DOC-${campusKey}-${n}`,
      title: `Document ${campusKey}${i + 1}`,
      slug: `document-${campusKey.toLowerCase()}-${i + 1}`,
      description: 'Fixture GED document',
      type: DOC_TYPES[i % DOC_TYPES.length],
      category: DOC_CATEGORIES[i % DOC_CATEGORIES.length],
      tags: ['fixture'],
      campusId: ctx.campusIds[campusKey],
      createdBy: { userId: ctx.adminIds.ADMIN, userModel: 'Admin' },
      rawHtml: `<p>Fixture document ${campusKey}${i + 1}</p>`,
      importedFile: {
        fileName: `doc-${campusKey.toLowerCase()}-${n}.pdf`,
        originalName: `doc-${n}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 120000 + i * 1000,
        extension: 'pdf',
        uploadedAt: ctx.at(-70 + i),
      },
      // Deleted documents keep this status: it is the trap, not an oversight.
      status: 'PUBLISHED',
      publishedAt: ctx.at(-70 + i),
      isOfficial: i % 2 === 0,
      retentionPolicy: 'PERMANENT',
      metadata: {
        studentId: student._id,
        classId: student.studentClass,
        semester: 'S2',
        academicYear: ACADEMIC_YEAR,
      },
      currentVersion: 1,
      ...stamps(70 - i),
      ...(deleted
        ? {
          ...ctx.softDelete('Document', ctx.at(-8)),
          deletedBy: { userId: ctx.adminIds.ADMIN, userModel: 'Admin' },
        }
        : { deletedAt: null }),
    };
  });
};

/**
 * @param {string} campusKey
 * @param {Object} ctx
 * @returns {Object[]}
 */
const buildAnnouncements = (campusKey, ctx) => {
  const counts = COUNTS[campusKey];

  return Array.from({ length: counts.announcements }, (_, i) => {
    const n = pad(i + 1);
    const rank = i + 1;
    const deleted = rank > counts.announcements - counts.announcementsDeleted;
    const expiredAlive = !deleted
      && rank > counts.announcements - counts.announcementsDeleted - counts.announcementsExpiredAlive;

    return {
      _id: oid(`announcement:${campusKey}:${n}`),
      schoolCampus: ctx.campusIds[campusKey],
      title: `Announcement ${campusKey}${rank}`,
      content: `Fixture announcement body ${campusKey}${rank}`,
      type: ['info', 'warning', 'urgent', 'event'][i % 4],
      targetRoles: ['ALL'],
      pinned: i === 0,
      pinnedUntil: i === 0 ? ctx.at(15) : null,
      // An expired announcement is LIVE and carries `status: 'archived'`; a
      // deleted one keeps `status: 'published'` and carries `deletedAt`.
      status: expiredAlive ? 'archived' : 'published',
      publishedAt: ctx.at(-30 + i),
      expiresAt: expiredAlive ? ctx.at(-2) : ctx.at(30),
      archivedAt: expiredAlive ? ctx.at(-2) : null,
      createdBy: { userId: ctx.adminIds.ADMIN, role: 'ADMIN', name: 'Fixture Admin' },
      ...stamps(30 - i),
      ...(deleted ? ctx.softDelete('Announcement', ctx.at(-7)) : { deletedAt: null }),
    };
  });
};

/**
 * @param {Object} ctx
 * @returns {Array<{ model: string, docs: Object[] }>}
 */
const build = (ctx) => [
  { model: 'Document', docs: CAMPUS_KEYS.flatMap((key) => buildDocuments(key, ctx)) },
  { model: 'Announcement', docs: CAMPUS_KEYS.flatMap((key) => buildAnnouncements(key, ctx)) },
];

module.exports = { build };
