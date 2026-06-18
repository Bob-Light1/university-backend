'use strict';

/**
 * @file student.service.js — API inter-modules du domaine student.
 *
 * Couche d'orchestration : compose les filtres/paramètres métier puis délègue
 * toute la persistance à student.repository (seul à toucher les models).
 *
 * Exposé (par modèle possédé) :
 *
 *  Student :
 *   - entityConfig : config GenericEntityController (campus.controller).
 *   - validateStudentBelongsToCampus : garde multi-tenant (result.crud,
 *     student.attendance.controller).
 *   - countStudents : compteur paramétrable (staff.readonly, mentor ×2,
 *     campus ×3, teacher.dashboard).
 *   - listStudentIds : ids des inscrits par classe (mentor.controller, result.crud).
 *   - listStudentsForStaff / ForMentor / ForCampusDashboard : listings paginés.
 *   - getStudentClassRef : classe courante d'un enfant (parent.portal).
 *   - getStudentsCampusRefs : validation de rattachement (parent.crud).
 *   - getStudentForDocument : génération de documents typés (document.template).
 *   - getStudentProfileRef : en-tête de relevé (result.analytics).
 *   - listStudentsForExamEligibility : éligibilité examens (exam.enrollment).
 *   - getStudentForPrint / listClassStudentsForCards / listClassStudentsForList /
 *     getStudentNamesByIds : impressions académiques (academic-print).
 *
 *  StudentSchedule :
 *   - resolveSessionParticipants / syncTeacherSchedule : création de sessions
 *     (gaet ; délègue subject/class/teacher aux façades propriétaires).
 *   - createScheduleSession : génération GAET.
 *   - listSessionsForClass : requête bornée (parent.portal ×3, academic-print ×2).
 *   - updateAttendanceSummary / getSessionRoster : appel/roster (teacher.schedule).
 *   - upsert/updateStudentScheduleByReference : miroir examens (exam.schedule.helper).
 *
 *  StudentAttendance :
 *   - summarizeStudentAttendance : résumé par enfant (parent.portal ×2).
 *   - summarizeAttendanceTotals : totaux campus/mentor (staff.readonly, mentor.readonly).
 *   - getAvgAbsenceRateForCampus : taux d'absence moyen (campus.controller).
 *   - listStudentAttendanceForParent / listAttendanceForStaff / ForMentor :
 *     listings paginés.
 *   - getStudentAttendanceStats : statique getStudentStats (exam.enrollment).
 */

const mongoose = require('mongoose');
const studentRepo = require('./student.repository');

const entityConfig = require('./student.config');
const {
  resolveSessionParticipants,
  syncTeacherSchedule,
} = require('./student.schedule.helpers');

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT
// ─────────────────────────────────────────────────────────────────────────────

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

    const student = await studentRepo.findStudentCampusRef(studentId);
    if (!student) return false;

    return student.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating student campus:', error);
    return false;
  }
};

/**
 * Compteur de students paramétrable.
 * @param {{
 *   campusId?:        string|ObjectId,
 *   studentIds?:      Array,           - restreint à ces _id
 *   studentClassIds?: Array,           - restreint à ces classes (studentClass)
 *   status?:          string,          - valeur exacte (ex. 'active')
 *   excludeArchived?: boolean,         - status ≠ 'archived'
 *   createdSince?:    Date,
 * }} params
 * @returns {Promise<number>}
 */
const countStudents = ({ campusId, studentIds, studentClassIds, status, excludeArchived, createdSince } = {}) => {
  const filter = {};
  if (campusId)        filter.schoolCampus = campusId;
  if (studentIds)      filter._id          = { $in: studentIds };
  if (studentClassIds) filter.studentClass = { $in: studentClassIds };
  if (status)          filter.status       = status;
  else if (excludeArchived) filter.status  = { $ne: 'archived' };
  if (createdSince)    filter.createdAt    = { $gte: createdSince };
  return studentRepo.countStudents(filter);
};

/**
 * Ids des students inscrits dans une ou plusieurs classes (source de vérité :
 * Student.studentClass, pas Class.students[]).
 * @param {{classIds: Array, campusId: string|ObjectId, excludeArchived?: boolean}} params
 * @returns {Promise<Array<{_id}>>}
 */
const listStudentIds = ({ classIds, campusId, excludeArchived = false }) => {
  const filter = {
    studentClass: { $in: classIds },
    schoolCampus: campusId,
  };
  if (excludeArchived) filter.status = { $ne: 'archived' };
  return studentRepo.listStudentIds(filter);
};

/**
 * Listing paginé des students pour le portail staff (classe peuplée, tri
 * alphabétique). `search` doit déjà être échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForStaff = ({ campusId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForStaff(filter, { skip, limit: Number(limit) });
};

/**
 * Listing paginé des students assignés à un mentor. `search` doit déjà être
 * échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForMentor = ({ studentIds, status, classId, search, page = 1, limit = 20 }) => {
  const filter = { _id: { $in: studentIds } };
  if (status)  filter.status = status;
  if (classId) filter.studentClass = classId;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForMentor(filter, { skip, limit: Number(limit) });
};

/**
 * Listing paginé des students pour le dashboard campus (tri par date de
 * création desc). `search` doit déjà être échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForCampusDashboard = ({ campusId, classId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (classId) filter.studentClass = classId;
  if (status)  filter.status = status;
  if (search) {
    filter.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName:  { $regex: search, $options: 'i' } },
      { matricule: { $regex: search, $options: 'i' } },
      { email:     { $regex: search, $options: 'i' } },
    ];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForCampusDashboard(filter, { skip, limit: Number(limit) });
};

/**
 * Référence de classe courante d'un student d'un campus (portail parent).
 * @returns {Promise<{studentClass}|null>}
 */
const getStudentClassRef = (studentId, campusId) =>
  studentRepo.getStudentClassRef(studentId, campusId);

/**
 * Rattachements campus d'une liste de students (validation parent ↔ enfants).
 * @returns {Promise<Array<{_id, schoolCampus}>>}
 */
const getStudentsCampusRefs = (studentIds) =>
  studentRepo.getStudentsCampusRefs(studentIds);

/**
 * Student complet (lean) d'un campus — génération de documents typés.
 * @returns {Promise<Object|null>}
 */
const getStudentForDocument = (studentId, campusId) =>
  studentRepo.getStudentForDocument(studentId, campusId);

/**
 * Profil minimal d'un student (en-tête de relevé de notes).
 * @returns {Promise<Object|null>}
 */
const getStudentProfileRef = (studentId) =>
  studentRepo.getStudentProfileRef(studentId);

/**
 * Students candidats à l'éligibilité d'une session d'examen.
 * NB : filtre sur `currentClass` (champ historique de l'éligibilité examens),
 * pas `studentClass` — comportement préservé tel quel.
 * @param {{classIds: Array<string>, campusId?: string|ObjectId}} params
 * @returns {Promise<Array>} documents Mongoose (_id, currentClass)
 */
const listStudentsForExamEligibility = ({ classIds, campusId }) =>
  studentRepo.listStudentsForExamEligibility({ classIds, campusId });

/**
 * Student d'un campus avec les champs nécessaires aux impressions (carte,
 * certificat de scolarité…).
 * @returns {Promise<Object|null>}
 */
const getStudentForPrint = (studentId, campusId) =>
  studentRepo.getStudentForPrint(studentId, campusId);

/**
 * Students non archivés d'une classe avec les champs cartes (impression en lot).
 * @returns {Promise<Array>}
 */
const listClassStudentsForCards = (classId, campusId) =>
  studentRepo.listClassStudentsForCards(classId, campusId);

/**
 * Students non archivés d'une classe, triés, pour la liste de classe imprimée.
 * @returns {Promise<Array>}
 */
const listClassStudentsForList = (classId, campusId) =>
  studentRepo.listClassStudentsForList(classId, campusId);

/**
 * Noms/matricules d'une liste de students d'un campus (cibles de lot d'impression).
 * @returns {Promise<Array<{_id, firstName, lastName, matricule}>>}
 */
const getStudentNamesByIds = (studentIds, campusId) =>
  studentRepo.getStudentNamesByIds(studentIds, campusId);

/**
 * Coordonnées de notification d'un lot d'étudiants (email/téléphone).
 * Consommé par les émetteurs de notification (result/exam) pour activer le
 * canal email sans qu'ils touchent le model Student.
 * @returns {Promise<Array<{_id, email, phone}>>}
 */
const getStudentContacts = (studentIds) =>
  studentRepo.getStudentContactsByIds(studentIds);

/**
 * Coordonnées d'un seul étudiant (commodité pour les émetteurs unitaires).
 * @returns {Promise<{_id, email, phone}|null>}
 */
const getStudentContact = async (studentId) => {
  const [contact] = await studentRepo.getStudentContactsByIds([studentId]);
  return contact || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée une session StudentSchedule (génération GAET).
 * @param {Object} payload - document complet (campus, horaires, subject/teacher/classes dénormalisés…)
 * @returns {Promise<Object>} document créé
 */
const createScheduleSession = (payload) => studentRepo.createScheduleSession(payload);

/**
 * Sessions d'une classe d'un campus, requête bornée.
 * @param {Object} params - voir student.repository.listSessionsForClass
 * @returns {Promise<Array>}
 */
const listSessionsForClass = (params) => studentRepo.listSessionsForClass(params);

/**
 * Met à jour le résumé d'appel d'une session StudentSchedule (sync depuis le
 * roll-call TeacherSchedule).
 */
const updateAttendanceSummary = (studentScheduleId, summaryFields) =>
  studentRepo.updateAttendanceSummary(studentScheduleId, summaryFields);

/**
 * Roster (classes + effectif attendu) d'une session, classes peuplées.
 * @returns {Promise<{classes, expectedAttendees}|null>}
 */
const getSessionRoster = (studentScheduleId) =>
  studentRepo.getSessionRoster(studentScheduleId);

/**
 * Upsert d'une entrée StudentSchedule par référence (miroir des sessions
 * d'examen — références EXAM-SS-*).
 */
const upsertStudentScheduleByReference = (reference, fields) =>
  studentRepo.upsertStudentScheduleByReference(reference, fields);

/**
 * Mise à jour d'une entrée StudentSchedule par référence (statut/horaires
 * d'une session d'examen annulée/reportée).
 */
const updateStudentScheduleByReference = (reference, fields) =>
  studentRepo.updateStudentScheduleByReference(reference, fields);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résumé de présence d'un student (totaux + taux calculé par l'appelant).
 * @param {Object} params - voir student.repository.summarizeStudentAttendance
 * @returns {Promise<Array>} résultat d'agrégation ([0] ou vide)
 */
const summarizeStudentAttendance = (params) =>
  studentRepo.summarizeStudentAttendance(params);

/**
 * Totaux présence d'un campus (ou des classes d'un mentor).
 * NB : la comparaison `status === 'present'` (chaîne) est historique et
 * préservée telle quelle.
 * @param {{campusId: ObjectId, classIds?: Array}} params
 * @returns {Promise<Array<{total, present}>>}
 */
const summarizeAttendanceTotals = (params) =>
  studentRepo.summarizeAttendanceTotals(params);

/**
 * Taux d'absence moyen par student d'un campus (agrégat dashboard campus).
 * @param {ObjectId} campusOid
 * @returns {Promise<Array<{avgAbsenceRate}>>}
 */
const getAvgAbsenceRateForCampus = (campusOid) =>
  studentRepo.getAvgAbsenceRateForCampus(campusOid);

/**
 * Relevé de présence paginé d'un enfant (portail parent).
 * @returns {Promise<{records: Array, total: number}>}
 */
const listStudentAttendanceForParent = (params) =>
  studentRepo.listStudentAttendanceForParent(params);

/**
 * Listing de présence du portail staff. Le statut texte est traduit en
 * combinaison status/isLate/isJustified (sémantique historique du staff).
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listAttendanceForStaff = ({ campusId, status, classId, studentId, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) {
    if      (status === 'present')  { filter.status = true;  filter.isLate = false; }
    else if (status === 'late')     { filter.isLate = true; }
    else if (status === 'excused')  { filter.status = false; filter.isJustified = true; }
    else if (status === 'absent')   { filter.status = false; filter.isJustified = { $ne: true }; }
  }
  if (classId)   filter.class   = classId;
  if (studentId) filter.student = studentId;
  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }
  return studentRepo.paginateAttendance(filter, { page, limit });
};

/**
 * Listing de présence du portail mentor (statut transmis tel quel —
 * sémantique historique du mentor, différente du staff et préservée).
 * L'autorisation (classe/student assignés) reste dans le controller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listAttendanceForMentor = ({ campusId, classId, classIds, studentId, status, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (classId)               filter.class   = classId;
  else if (classIds?.length) filter.class   = { $in: classIds };
  if (studentId)             filter.student = studentId;
  if (status)                filter.status  = status;
  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }
  return studentRepo.paginateAttendance(filter, { page, limit });
};

/**
 * Statistiques de présence d'un student (statique getStudentStats du model).
 * Retourne { attendanceRate: 100 } si la statique n'existe pas — comportement
 * préservé de l'éligibilité examens.
 */
const getStudentAttendanceStats = (studentId, academicYear, semester, scope) =>
  studentRepo.getStudentAttendanceStats(studentId, academicYear, semester, scope);

module.exports = {
  // Student
  entityConfig,
  validateStudentBelongsToCampus,
  countStudents,
  listStudentIds,
  listStudentsForStaff,
  listStudentsForMentor,
  listStudentsForCampusDashboard,
  getStudentClassRef,
  getStudentsCampusRefs,
  getStudentForDocument,
  getStudentProfileRef,
  listStudentsForExamEligibility,
  getStudentForPrint,
  listClassStudentsForCards,
  listClassStudentsForList,
  getStudentNamesByIds,
  getStudentContacts,
  getStudentContact,

  // StudentSchedule
  resolveSessionParticipants,
  syncTeacherSchedule,
  createScheduleSession,
  listSessionsForClass,
  updateAttendanceSummary,
  getSessionRoster,
  upsertStudentScheduleByReference,
  updateStudentScheduleByReference,

  // StudentAttendance
  summarizeStudentAttendance,
  summarizeAttendanceTotals,
  getAvgAbsenceRateForCampus,
  listStudentAttendanceForParent,
  listAttendanceForStaff,
  listAttendanceForMentor,
  getStudentAttendanceStats,
};
