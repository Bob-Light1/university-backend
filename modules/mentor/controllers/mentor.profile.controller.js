'use strict';

/**
 * @file mentor.profile.controller.js
 * @description Mentor self-service profile endpoints.
 *
 *  GET   /api/mentors/me                → getMe
 *  PATCH /api/mentors/me/profile        → updateProfile
 *  PATCH /api/mentors/me/password       → changePassword
 *  PATCH /api/mentors/me/profile-image  → uploadProfileImage
 *  PATCH /api/mentors/me/notifications  → updateNotifications
 *  GET   /api/mentors/me/upload-signature → getUploadSignature
 *
 * Campus isolation: filter always includes schoolCampus from JWT.
 */

const mongoose   = require('mongoose');
const Mentor     = require('../mentor.model');
const profileSvc = require('../../../services/profile.service');

const userFilter = (req) => ({
  _id:          new mongoose.Types.ObjectId(req.user.id),
  schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
});

const POPULATE = [
  { path: 'schoolCampus', select: 'campus_name' },
];

const ALLOWED_PROFILE_FIELDS = ['phone', 'specialization'];

const getMe = (req, res) =>
  profileSvc.getMe(res, Mentor, userFilter(req), POPULATE);

const updateProfile = (req, res) =>
  profileSvc.updateProfile(res, Mentor, userFilter(req), ALLOWED_PROFILE_FIELDS, req.body);

const changePassword = (req, res) =>
  profileSvc.changePassword(res, Mentor, userFilter(req), req.body);

const uploadProfileImage = (req, res) =>
  profileSvc.uploadProfileImage(res, Mentor, userFilter(req), req.body);

const updateNotifications = (req, res) =>
  profileSvc.updateNotifications(res, Mentor, userFilter(req), req.body);

const getUploadSignature = (_req, res) =>
  profileSvc.getUploadSignature(res);

module.exports = {
  getMe,
  updateProfile,
  changePassword,
  uploadProfileImage,
  updateNotifications,
  getUploadSignature,
};
