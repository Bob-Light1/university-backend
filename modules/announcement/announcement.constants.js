'use strict';

/** @file announcement.constants.js @description Announcement lifecycle, editable fields and internal operations. */
const STATUS = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived' });
const TYPES = Object.freeze(['info', 'warning', 'urgent', 'event']);
const ROLES = Object.freeze([
  'STUDENT', 'TEACHER', 'PARENT', 'PARTNER', 'STAFF', 'MENTOR',
  'CAMPUS_MANAGER', 'DIRECTOR', 'ADMIN', 'ALL',
]);
const EDITABLE_FIELDS = Object.freeze(['title', 'content', 'type', 'targetRoles', 'pinned', 'pinnedUntil', 'expiresAt']);
const OPERATION = Object.freeze({
  UPDATE: 'updateAnnouncement', PUBLISH: 'publishAnnouncement', ARCHIVE: 'archiveAnnouncement',
  PIN: 'togglePin', DELETE: 'deleteAnnouncement', EXPIRE: 'archiveExpired', UNPIN: 'unpinExpired',
});
const SWEEP_PAGE_SIZE = 100;

module.exports = Object.freeze({ STATUS, TYPES, ROLES, EDITABLE_FIELDS, OPERATION, SWEEP_PAGE_SIZE });
