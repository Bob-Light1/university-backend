const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SchoolCampus",
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    surname: {
      type: String,
      required: true,
      trim: true,
    },

    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    email: {
      type: String,
      unique: true,
      lowercase: true,
      index: true,
    },

    phone: {
      type: String,
      unique: true,
      sparse: true,  // allows multiple documents with no phone (null is not "unique")
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    roles: [
      {
        type: String,
        enum: [
          "SUPER_ADMIN",
          "DIRECTOR",
          "CAMPUS_MANAGER",
          "ACCOUNTANT",
          "IT",
          "TEACHER",
          "RESULT_MANAGER",
          "STUDENT",
          "PARENT",
          "PARTNER",
        ],
        default: "STUDENT",
      },
    ],

    permissions: [
      {
        type: String,
        enum: [
          "MANAGE_USERS",
          "MANAGE_EXPENSES",
          "APPROVE_EXPENSES",
          "MANAGE_RESULTS",
          "PUBLISH_RESULTS",
          "VIEW_REPORTS",
        ],
      },
    ],

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLoginAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
