'use strict';

/** @file student.creation.service.js @description Shared pending-student preparation for management, imports and admission. */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const mongoose = require('mongoose');
const repo = require('./student.repository');
const { nextSequence } = require('../../shared/db/counter.model');
const { resolveQuota } = require('../../shared/utils/entitlement');
const { isValidObjectId } = require('../../shared/utils/validation-helpers');
const { ADMISSION_ERRORS: E, admissionError } = require('../../shared/constants/admission.constants');

/** Validate a live class against the effective authenticated campus. */
async function validateAssignment(fields, campusId, session) {
  if (!isValidObjectId(fields.studentClass)) return { valid: false, error: 'A valid student class is required' };
  const klass = await require('../class').service.getClassCampusRefForValidation(fields.studentClass, { session });
  if (!klass || String(klass.schoolCampus) !== String(campusId)) {
    return { valid: false, error: 'The selected live class must belong to this campus' };
  }
  if (fields.matricule && await repo.findStudentByMatriculeInCampus(fields.matricule, campusId, { session })) {
    return { valid: false, error: 'The student matricule is already in use' };
  }
  return { valid: true };
}

/** Lock capacity and allocate a concurrency-safe identifier inside the caller's transaction. */
async function prepare(fields, campusId, session) {
  const campus = await require('../campus').service.lockAdmissionCampus(campusId, session);
  if (!campus) throw admissionError(E.NOT_FOUND, 'Campus not found', 404);
  const count = await repo.countLiveStudents(campusId, { session });
  if (count >= resolveQuota(campus, 'maxStudents')) throw admissionError(E.QUOTA, 'The campus student quota is exhausted', 409);
  if (!fields.matricule) {
    const sequence = await nextSequence('student-creation', { session });
    fields.matricule = `${campus.campus_number || 'CAM'}-STD-A${String(sequence).padStart(6, '0')}`;
  }
  return { success: true };
}

/** Create an activation-only student without accepting caller-controlled status, campus or credentials. */
async function createPendingStudent(fields, campusId, session) {
  if (!session) return mongoose.connection.transaction((ownedSession) => createPendingStudent(fields, campusId, ownedSession));
  const data = {};
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender', 'username', 'studentClass', 'matricule']) {
    if (fields[field] !== undefined && fields[field] !== '') data[field] = fields[field];
  }
  await prepare(data, campusId, session);
  const assignment = await validateAssignment(data, campusId, session);
  if (!assignment.valid) throw admissionError(E.INVALID, assignment.error);
  const password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  return repo.createPendingStudent({ ...data, schoolCampus: campusId, status: 'pending', password }, session);
}

/** Read-only import preview validates the same schema and class ownership without consuming capacity. */
async function validatePendingStudent(fields, campusId) {
  const assignment = await validateAssignment(fields, campusId);
  if (!assignment.valid) throw admissionError(E.INVALID, assignment.error);
  await repo.validatePendingStudent({ ...fields, schoolCampus: campusId, status: 'pending', password: crypto.randomBytes(32).toString('hex') });
}

module.exports = { validateAssignment, prepare, createPendingStudent, validatePendingStudent };
