/**
 * @file parent.service.js
 * API publique du module parent.
 *
 * Exposé :
 *   - removeChildFromAllParents(studentId) : retire un étudiant du tableau
 *     children[] de tous les parents (consommé par le hook post-delete de
 *     student.model lors d'un hard-delete).
 *   - getChildrenIds(parentId) : ids of a parent's children (consumed by the
 *     AI citation re-authorization in the document facade, Phase 3 §4.5).
 */

const parentRepo = require('./parent.repository');

/**
 * Retire studentId de children[] chez tous les parents concernés.
 * @param {ObjectId|string} studentId
 * @returns {Promise<{modifiedCount: number}>}
 */
const removeChildFromAllParents = (studentId) => parentRepo.removeChildFromAll(studentId);

/**
 * Ids (strings) of the children linked to a parent — [] when unknown.
 * @param {ObjectId|string} parentId
 * @returns {Promise<string[]>}
 */
const getChildrenIds = async (parentId) => {
  const parent = await parentRepo.findChildrenIdsOnly(parentId);
  return (parent?.children || []).map(String);
};

module.exports = {
  removeChildFromAllParents,
  getChildrenIds,
};
