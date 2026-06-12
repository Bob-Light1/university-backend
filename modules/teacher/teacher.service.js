'use strict';

/**
 * @file teacher.service.js — API inter-modules du domaine teacher.
 *
 * Exposé :
 *   - validateTeacherBelongsToCampus : garde d'isolation multi-tenant
 *     (consommé par class.controller et teacher.attendance.controller).
 *
 * Reste à résorber : les consommateurs des shims models/teacher-models/
 * (~7 modules) — vague C2 du chantier 20b.
 */

const mongoose = require('mongoose');
const Teacher = require('./models/teacher.model');

/**
 * Check if a teacher belongs to a specific campus
 * @param {String} teacherId - Teacher ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateTeacherBelongsToCampus = async (teacherId, campusId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(teacherId) ||
        !mongoose.Types.ObjectId.isValid(campusId)) {
      return false;
    }

    const teacher = await Teacher.findById(teacherId);

    if (!teacher) {
      return false;
    }

    return teacher.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating teacher campus:', error);
    return false;
  }
};

module.exports = {
  validateTeacherBelongsToCampus,
};
