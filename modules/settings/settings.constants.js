'use strict';
/** @file settings.constants.js @description Preference-storage discriminators; Director remains distinct from the authentication Admin model. */
const USER_MODELS = Object.freeze({
  ADMIN: 'Admin', DIRECTOR: 'Director', CAMPUS_MANAGER: 'Campus',
  TEACHER: 'Teacher', STUDENT: 'Student', PARENT: 'Parent',
  MENTOR: 'Mentor', STAFF: 'Staff', PARTNER: 'Partner',
});
module.exports = { USER_MODELS };
