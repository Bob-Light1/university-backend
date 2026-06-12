'use strict';

/**
 * @file contact.message.model.js
 * @description Contact messages submitted via the portal contact form (spec §4.8).
 *
 * Subjects: 'registration' | 'partnership' | 'other'
 * Status: 'new' → 'read' → 'replied'
 *
 * The admin reads and replies from the ERP; the portal only writes (POST).
 */

const mongoose = require('mongoose');

const contactMessageSchema = new mongoose.Schema(
  {
    // Campus resolution (from campusSlug in the payload)
    schoolCampus: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'Campus',
      index: true,
    },

    // Sender identity
    name: {
      type:     String,
      required: [true, 'Name is required'],
      trim:     true,
    },

    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
    },

    phone: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Message content
    subject: {
      type:    String,
      enum:    {
        values:  ['registration', 'partnership', 'other'],
        message: '{VALUE} is not a valid subject',
      },
      default: 'other',
    },

    message: {
      type:     String,
      required: [true, 'Message is required'],
      trim:     true,
    },

    // Workflow
    status: {
      type:    String,
      enum:    ['new', 'read', 'replied'],
      default: 'new',
      index:   true,
    },

    repliedAt: {
      type:    Date,
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
  }
);

contactMessageSchema.index({ schoolCampus: 1, status: 1 });

const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);
module.exports = ContactMessage;
