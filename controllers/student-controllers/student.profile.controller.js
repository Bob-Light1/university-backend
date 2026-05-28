'use strict';

/**
 * @file student.profile.controller.js
 * @description Student self-service profile endpoints.
 *
 *  GET   /api/students/me                → getMe
 *  PATCH /api/students/me/profile        → updateProfile
 *  PATCH /api/students/me/password       → changePassword
 *  PATCH /api/students/me/profile-image  → uploadProfileImage
 *  PATCH /api/students/me/notifications  → updateNotifications
 *
 * All handlers delegate to profile.service.js — no bcrypt / whitelist
 * logic lives here.
 * Campus isolation: filter always includes schoolCampus from JWT.
 */

const mongoose = require('mongoose');
const Student  = require('../../models/student-models/student.model');
const profileSvc = require('../../services/profile.service');

// campusId-aware filter (prevents a student from accessing another campus's data)
const userFilter = (req) => ({
  _id:          new mongoose.Types.ObjectId(req.user.id),
  schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
});

// Populate own class for context
const POPULATE = [
  { path: 'studentClass', select: 'className level' },
  { path: 'schoolCampus', select: 'campus_name' },
];

const ALLOWED_PROFILE_FIELDS = ['phone', 'emergencyContact'];

const getMe = (req, res) =>
  profileSvc.getMe(res, Student, userFilter(req), POPULATE);

const updateProfile = (req, res) =>
  profileSvc.updateProfile(res, Student, userFilter(req), ALLOWED_PROFILE_FIELDS, req.body);

const changePassword = (req, res) =>
  profileSvc.changePassword(res, Student, userFilter(req), req.body);

const uploadProfileImage = (req, res) =>
  profileSvc.uploadProfileImage(res, Student, userFilter(req), req.body);

const updateNotifications = (req, res) =>
  profileSvc.updateNotifications(res, Student, userFilter(req), req.body);

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
