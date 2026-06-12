'use strict';

/**
 * @file student.service.js — API inter-modules du domaine student.
 *
 * Exposé :
 *   - entityConfig : config GenericEntityController (consommé par campus,
 *     qui instancie un controller d'entité student pour son dashboard).
 *   - validateStudentBelongsToCampus : garde d'isolation multi-tenant
 *     (consommé par result.crud et student.attendance.controller).
 *
 * Reste à résorber : les consommateurs des shims models/student-models/
 * (~13 pour student.model) — vague C du chantier 20b.
 */

const mongoose = require('mongoose');
const Student = require('./models/student.model');

const entityConfig = require('./student.config');

/**
 * Check if a student belongs to a specific campus
 * @param {String} studentId - Student ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateStudentBelongsToCampus = async (studentId, campusId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(studentId) ||
        !mongoose.Types.ObjectId.isValid(campusId)) {
      return false;
    }

    const student = await Student.findById(studentId);

    if (!student) {
      return false;
    }

    return student.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating student campus:', error);
    return false;
  }
};

module.exports = {
  entityConfig,
  validateStudentBelongsToCampus,
};
