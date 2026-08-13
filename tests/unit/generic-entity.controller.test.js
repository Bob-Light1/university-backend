'use strict';

/**
 * GenericEntityController — dérivation de la convention de suppression.
 *
 * Ce contrôleur est GÉNÉRIQUE mais `status: 'archived'` n'est qu'une convention sur trois
 * (CLAUDE.md §5.1). Ses consommateurs actuels (Student, Teacher, Department, Campus)
 * appartiennent tous à la famille `status`, donc une valeur codée en dur y reste correcte —
 * et le jour où un modèle de la famille `isDeleted` y est branché, l'échec est SILENCIEUX :
 *
 *  - `filter.status = { $ne: 'archived' }` ne matche rien → liste vide plausible ;
 *  - `entity.status = 'archived'` sur un schéma sans chemin `status` est ignoré par Mongoose
 *    (`strict: true`), `save()` réussit, et la route répond « archived successfully » sans
 *    avoir rien archivé.
 *
 * Ces tests épinglent donc les trois sites (liste / archive / restore) sur DEUX familles :
 * si quelqu'un recode la convention en dur, la famille `isDeleted` casse immédiatement.
 */

const { softDeleteSchemaStub } = require('../helpers/soft-delete-stub');

jest.mock('../../shared/utils/response-helpers', () => ({
  sendSuccess:   jest.fn((res, code, message, data) => ({ code, message, data })),
  sendError:     jest.fn((res, code, message) => ({ code, message })),
  sendPaginated: jest.fn((res, code, message, data) => ({ code, message, data })),
  sendCreated:   jest.fn(),
  sendNotFound:  jest.fn((res, name) => ({ code: 404, name })),
  sendConflict:  jest.fn(),
  handleDuplicateKeyError: jest.fn(),
}));

const GenericEntityController = require('../../shared/lib/generic-entity.controller');

/** Minimal model double: query chain + a savable document. */
const buildModel = (modelName, markers) => {
  const query = {};
  ['select', 'sort', 'skip', 'limit', 'populate'].forEach((m) => { query[m] = jest.fn(() => query); });
  query.exec = jest.fn().mockResolvedValue([]);

  const doc = { _id: 'e1', schoolCampus: 'campus-1', save: jest.fn().mockResolvedValue() };

  return {
    modelName,
    schema:         softDeleteSchemaStub(markers),
    find:           jest.fn(() => query),
    countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(0) })),
    findById:       jest.fn().mockResolvedValue(doc),
    aggregate:      jest.fn().mockResolvedValue([{ total: [{ count: 9 }] }]),
    __doc:          doc,
  };
};

const ADMIN = { role: 'ADMIN', id: 'a1' };
const res   = {};

const controllerFor = (Model) =>
  new GenericEntityController({ Model, entityName: 'Widget', folderName: 'widgets' });

beforeEach(() => jest.clearAllMocks());

describe('getAll — le filtre « non supprimé » vient du modèle', () => {
  test('famille status → status: { $ne: archived }', async () => {
    const Model = buildModel('Widget', 'status');
    await controllerFor(Model).getAll({ query: {}, user: ADMIN }, res);
    expect(Model.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: 'archived' } }),
    );
  });

  test('famille isDeleted → isDeleted: false (et JAMAIS un filtre de statut)', async () => {
    const Model = buildModel('Record', 'isDeleted');
    await controllerFor(Model).getAll({ query: {}, user: ADMIN }, res);
    const [filter] = Model.find.mock.calls[0];
    expect(filter).toMatchObject({ isDeleted: false });
    expect(filter).not.toHaveProperty('status');
  });

  test('famille deletedAt → deletedAt: null', async () => {
    const Model = buildModel('Ged', 'deletedAt');
    await controllerFor(Model).getAll({ query: {}, user: ADMIN }, res);
    expect(Model.find).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: null }));
  });

  test('includeArchived=true → aucun marqueur de suppression appliqué', async () => {
    const Model = buildModel('Record', 'isDeleted');
    await controllerFor(Model).getAll({ query: { includeArchived: 'true' }, user: ADMIN }, res);
    const [filter] = Model.find.mock.calls[0];
    expect(filter).not.toHaveProperty('isDeleted');
  });
});

describe('getStats — la portée est « vivant », pas « actif »', () => {
  const CAMPUS = '507f1f77bcf86cd799439011';

  test('le $match dérive du modèle et n\'exclut PAS pending / inactive / suspended', async () => {
    const Model = buildModel('Widget', 'status');
    await controllerFor(Model).getStats({ params: { campusId: CAMPUS }, user: ADMIN }, res);

    const [pipeline] = Model.aggregate.mock.calls[0];
    expect(pipeline[0].$match).toMatchObject({ status: { $ne: 'archived' } });
    // Le bug corrigé : `status: 'active'` sortait des totaux toute cohorte importée, que le
    // flux d'activation crée en `pending`, et rendait les facettes byStatus mono-valuées.
    expect(pipeline[0].$match.status).not.toBe('active');
  });

  test('famille isDeleted : aucun filtre de statut dans le $match', async () => {
    const Model = buildModel('Record', 'isDeleted');
    await controllerFor(Model).getStats({ params: { campusId: CAMPUS }, user: ADMIN }, res);

    const [pipeline] = Model.aggregate.mock.calls[0];
    expect(pipeline[0].$match).toMatchObject({ isDeleted: false });
    expect(pipeline[0].$match).not.toHaveProperty('status');
  });
});

describe('archive / restore — le patch vient du modèle', () => {
  test('famille status : archive écrit le statut, restore rend le défaut du schéma', async () => {
    const Model = buildModel('Widget', 'status');
    const ctrl  = controllerFor(Model);
    const req   = { params: { id: '507f1f77bcf86cd799439011' }, user: ADMIN };

    await ctrl.archive(req, res);
    expect(Model.__doc.status).toBe('archived');

    await ctrl.restore(req, res);
    expect(Model.__doc.status).toBe('active');
  });

  test('famille isDeleted : archive écrit le booléen, PAS un statut fantôme', async () => {
    const Model = buildModel('Record', 'isDeleted');
    const ctrl  = controllerFor(Model);
    const req   = { params: { id: '507f1f77bcf86cd799439011' }, user: ADMIN };

    await ctrl.archive(req, res);
    expect(Model.__doc.isDeleted).toBe(true);
    // Le bug que ce test existe pour attraper : une écriture `status` muette.
    expect(Model.__doc.status).toBeUndefined();
    expect(Model.__doc.save).toHaveBeenCalled();

    await ctrl.restore(req, res);
    expect(Model.__doc.isDeleted).toBe(false);
  });

  test('famille deletedAt : archive horodate, restore remet à null', async () => {
    const Model = buildModel('Ged', 'deletedAt');
    const ctrl  = controllerFor(Model);
    const req   = { params: { id: '507f1f77bcf86cd799439011' }, user: ADMIN };

    await ctrl.archive(req, res);
    expect(Model.__doc.deletedAt).toBeInstanceOf(Date);

    await ctrl.restore(req, res);
    expect(Model.__doc.deletedAt).toBeNull();
  });

  test('modèle sans convention : échec fermé, jamais un succès silencieux', async () => {
    // Nom distinct : resolveStrategy mémoïse par modelName (une seule définition par nom
    // côté Mongoose, mais deux doubles homonymes se partageraient le cache ici).
    const Model = buildModel('Unmarked', 'status');
    Model.schema = { path: () => undefined };   // aucun marqueur
    const ctrl   = controllerFor(Model);
    const req    = { params: { id: '507f1f77bcf86cd799439011' }, user: ADMIN };

    const out = await ctrl.archive(req, res);
    expect(out.code).toBe(500);
    expect(Model.__doc.save).not.toHaveBeenCalled();
  });
});
