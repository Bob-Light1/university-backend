'use strict';

/**
 * @file teacher.profile.controller.js
 * @description Teacher self-service profile endpoints.
 *
 *  GET   /api/teachers/me                → getMe
 *  PATCH /api/teachers/me/profile        → updateProfile
 *  PATCH /api/teachers/me/password       → changePassword
 *  PATCH /api/teachers/me/profile-image  → uploadProfileImage
 *  PATCH /api/teachers/me/notifications  → updateNotifications
 *
 * Campus isolation: filter always includes schoolCampus from JWT.
 */

const mongoose = require('mongoose');
const Teacher  = require('../models/teacher.model');
const profileSvc = require('../../../services/profile.service');

const userFilter = (req) => ({
  _id:          new mongoose.Types.ObjectId(req.user.id),
  schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
});

const POPULATE = [
  { path: 'schoolCampus', select: 'campus_name' },
  { path: 'department',   select: 'department_name' },
];

const ALLOWED_PROFILE_FIELDS = ['phone', 'emergencyContact'];

const getMe = (req, res) =>
  profileSvc.getMe(res, Teacher, userFilter(req), POPULATE);

const updateProfile = (req, res) =>
  profileSvc.updateProfile(res, Teacher, userFilter(req), ALLOWED_PROFILE_FIELDS, req.body);

const changePassword = (req, res) =>
  profileSvc.changePassword(res, Teacher, userFilter(req), req.body);

const uploadProfileImage = (req, res) =>
  profileSvc.uploadProfileImage(res, Teacher, userFilter(req), req.body);

const updateNotifications = (req, res) =>
  profileSvc.updateNotifications(res, Teacher, userFilter(req), req.body);

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
