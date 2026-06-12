'use strict';

/**
 * @file partner.application.model.js
 * @description Candidatures partenaire soumises via le portail (spec §4.9 / §8.6).
 *
 * Distinct du modèle Partner. Status: pending → approved → rejected.
 * On approval, the admin creates a real Partner record and sets partnerId.
 */

const mongoose = require('mongoose');

const partnerApplicationSchema = new mongoose.Schema(
  {
    // Campus resolved from campusSlug in the payload
    schoolCampus: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Campus',
      default: null,
      index:   true,
    },

    // Applicant identity
    firstName: {
      type:     String,
      required: [true, 'First name is required'],
      trim:     true,
    },

    lastName: {
      type:     String,
      required: [true, 'Last name is required'],
      trim:     true,
    },

    email: {
      type:      String,
      required:  [true, 'Email is required'],
      lowercase: true,
      trim:      true,
    },

    phone: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Partnership type (spec §8.6)
    commercialType: {
      type:    String,
      enum:    {
        values:  ['influencer', 'church_leader', 'student_leader', 'teacher', 'parent', 'other'],
        message: '{VALUE} is not a valid commercial type',
      },
      default: 'other',
    },

    // Preferred operating channel
    channelType: {
      type:    String,
      enum:    {
        values:  ['online', 'offline', 'hybrid'],
        message: '{VALUE} is not a valid channel type',
      },
      default: 'hybrid',
    },

    // Free-form motivation
    message: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Workflow
    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
      index:   true,
    },

    reviewedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Staff',
      default: null,
    },

    reviewedAt: {
      type:    Date,
      default: null,
    },

    reviewNote: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Filled on approval — references the created Partner record
    partnerId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Partner',
      default: null,
    },

    // Anti-fraud
    ipAddressHash: {
      type:    String,
      default: null,
    },

    honeypotTripped: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

partnerApplicationSchema.index({ schoolCampus: 1, status: 1 });
partnerApplicationSchema.index({ email: 1, schoolCampus: 1 });

partnerApplicationSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

const PartnerApplication = mongoose.model('PartnerApplication', partnerApplicationSchema);
module.exports = PartnerApplication;
