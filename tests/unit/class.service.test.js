'use strict';

/**
 * Bug latent #8 — class.service.getClassForDocumentList
 *
 * Avant correctif : la requête filtrait sur `campus` (champ inexistant ; le vrai
 * champ est `schoolCampus`) → findOne ne matchait jamais → l'endpoint
 * POST /api/documents/generate/class-list/:classId répondait 404 en permanence.
 *
 * Ces tests verrouillent le comportement CORRIGÉ : filtre sur `schoolCampus`,
 * sans le champ fantôme `campus`. Le model Class est mocké (aucune DB).
 */

// Mock du model Mongoose : findOne(filter).select(...).lean()
// (chemin en littéral + tout construit DANS la factory — contraintes de hoisting de jest.mock).
jest.mock('../../modules/class/class.model', () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: 'class-1', className: 'CM1', schoolCampus: 'campus-1' }),
  };
  return { findOne: jest.fn(() => query), __query: query };
});

const Class = require('../../modules/class/class.model');
const classService = require('../../modules/class/class.service');

describe('getClassForDocumentList (bug #8)', () => {
  beforeEach(() => {
    Class.findOne.mockClear();
    Class.__query.select.mockClear();
    Class.__query.lean.mockClear();
  });

  test('filtre sur schoolCampus (et JAMAIS sur le champ fantôme `campus`)', async () => {
    await classService.getClassForDocumentList('class-1', 'campus-1');

    expect(Class.findOne).toHaveBeenCalledTimes(1);
    const filter = Class.findOne.mock.calls[0][0];
    expect(filter).toHaveProperty('schoolCampus', 'campus-1');
    expect(filter).toHaveProperty('_id', 'class-1');
    expect(filter).not.toHaveProperty('campus'); // ← le bug
  });

  test('retourne le document de classe (lean)', async () => {
    const doc = await classService.getClassForDocumentList('class-1', 'campus-1');
    expect(doc).toEqual({ _id: 'class-1', className: 'CM1', schoolCampus: 'campus-1' });
    expect(Class.__query.lean).toHaveBeenCalled();
  });
});
