'use strict';

/**
 * @file staff.profile.controller.js
 * @description Staff self-service profile endpoints.
 *
 *  GET   /api/staff/me                → getMe
 *  PATCH /api/staff/me/profile        → updateProfile
 *  PATCH /api/staff/me/password       → changePassword
 *  PATCH /api/staff/me/profile-image  → uploadProfileImage
 *  PATCH /api/staff/me/notifications  → updateNotifications
 *  GET   /api/staff/me/upload-signature → getUploadSignature
 *
 * Campus isolation: filter always includes schoolCampus from JWT.
 */

const mongoose   = require('mongoose');
const Staff      = require('../../models/staff.model');
const profileSvc = require('../../services/profile.service');

const userFilter = (req) => ({
  _id:          new mongoose.Types.ObjectId(req.user.id),
  schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
});

const POPULATE = [
  { path: 'schoolCampus', select: 'campus_name' },
  { path: 'subRole',      select: 'name permissions isActive' },
];

const ALLOWED_PROFILE_FIELDS = ['phone'];

const getMe = (req, res) =>
  profileSvc.getMe(res, Staff, userFilter(req), POPULATE);

const updateProfile = (req, res) =>
  profileSvc.updateProfile(res, Staff, userFilter(req), ALLOWED_PROFILE_FIELDS, req.body);

const changePassword = (req, res) =>
  profileSvc.changePassword(res, Staff, userFilter(req), req.body);

const uploadProfileImage = (req, res) =>
  profileSvc.uploadProfileImage(res, Staff, userFilter(req), req.body);

const updateNotifications = (req, res) =>
  profileSvc.updateNotifications(res, Staff, userFilter(req), req.body);

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
