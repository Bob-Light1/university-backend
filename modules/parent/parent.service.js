/**
 * @file parent.service.js
 * API publique du module parent.
 *
 * Exposé :
 *   - removeChildFromAllParents(studentId) : retire un étudiant du tableau
 *     children[] de tous les parents (consommé par le hook post-delete de
 *     student.model lors d'un hard-delete).
 */

const Parent = require('./parent.model');

/**
 * Retire studentId de children[] chez tous les parents concernés.
 * @param {ObjectId|string} studentId
 * @returns {Promise<{modifiedCount: number}>}
 */
const removeChildFromAllParents = (studentId) =>
  Parent.updateMany(
    { children: studentId },
    { $pull: { children: studentId } }
  ).exec();

module.exports = {
  removeChildFromAllParents,
};
