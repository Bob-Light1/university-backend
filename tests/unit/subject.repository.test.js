'use strict';

/**
 * Repository layer — subject module (R1, last).
 * Locks down the filters (uniqueness, campus/status/search pagination, inter-module
 * API) and the load→mutate→save semantics. Model mocked (no DB).
 */

jest.mock('../../modules/subject/subject.model', () => {
  let nextLean = null;
  let nextDoc = null;
  const makeQuery = () => {
    const q = {};
    ['populate', 'select', 'sort', 'skip', 'limit', 'session'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(nextLean));
    q.then = (res, rej) => Promise.resolve(nextDoc).then(res, rej);
    return q;
  };
  return {
    findOne:        jest.fn(() => makeQuery()),
    find:           jest.fn(() => makeQuery()),
    findById:       jest.fn(() => makeQuery()),
    countDocuments: jest.fn(() => Promise.resolve(3)),
    distinct:       jest.fn(() => Promise.resolve(['c1'])),
    create:         jest.fn((d) => Promise.resolve({ _id: 'new', ...d })),
    __setLean: (v) => { nextLean = v; },
    __setDoc:  (v) => { nextDoc = v; },
  };
});

const Subject = require('../../modules/subject/subject.model');
const repo = require('../../modules/subject/subject.repository');

beforeEach(() => {
  jest.clearAllMocks();
  Subject.__setLean(null);
  Subject.__setDoc(null);
});

describe('unicité', () => {
  test('findDuplicateCode filtre { schoolCampus, subject_code }', async () => {
    await repo.findDuplicateCode('c1', 'MATH');
    expect(Subject.findOne).toHaveBeenCalledWith({ schoolCampus: 'c1', subject_code: 'MATH' });
  });

  test('findDuplicateCodeExcept exclut l id courant', async () => {
    await repo.findDuplicateCodeExcept('c1', 'MATH', 's1');
    expect(Subject.findOne).toHaveBeenCalledWith({ _id: { $ne: 's1' }, schoolCampus: 'c1', subject_code: 'MATH' });
  });
});

describe('paginate', () => {
  test('défaut exclut archivés + fusionne baseFilter', async () => {
    await repo.paginate({ baseFilter: { schoolCampus: 'c1' }, skip: 0, limit: 50 });
    expect(Subject.find).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('includeArchived=true + status valide → status appliqué', async () => {
    await repo.paginate({ baseFilter: {}, includeArchived: true, status: 'archived', skip: 0, limit: 50 });
    expect(Subject.find).toHaveBeenCalledWith({ status: 'archived' });
  });

  test('recherche → $or name/code échappés', async () => {
    await repo.paginate({ baseFilter: {}, search: 'a+b', skip: 0, limit: 50 });
    const filter = Subject.find.mock.calls[0][0];
    expect(filter.$or[0].subject_name.$regex).toBe('a\\+b');
  });
});

describe('écritures', () => {
  test('updateById : introuvable → null', async () => {
    Subject.__setDoc(null);
    expect(await repo.updateById('x', { color: '#000' })).toBeNull();
  });

  test('updateById : assigne + save', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { _id: 's1', subject_name: 'old', save };
    Subject.__setDoc(doc);
    await repo.updateById('s1', { subject_name: 'NEW' });
    expect(doc.subject_name).toBe('NEW');
    expect(save).toHaveBeenCalled();
  });

  test('setStatus : change statut + save', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { status: 'active', save };
    Subject.__setDoc(doc);
    await repo.setStatus('s1', 'archived');
    expect(doc.status).toBe('archived');
  });

  test('setCourseRef : pose courseRef + save', async () => {
    const save = jest.fn().mockResolvedValue();
    const doc = { courseRef: null, save };
    Subject.__setDoc(doc);
    await repo.setCourseRef('s1', 'course-1');
    expect(doc.courseRef).toBe('course-1');
    expect(save).toHaveBeenCalled();
  });
});

describe('API inter-modules', () => {
  test('countOnCampus : { _id:$in, schoolCampus }', async () => {
    await repo.countOnCampus(['a', 'b'], 'c1');
    expect(Subject.countDocuments).toHaveBeenCalledWith({ _id: { $in: ['a', 'b'] }, schoolCampus: 'c1' });
  });

  test('distinctLinkedCourseRefs : actifs avec courseRef non null', async () => {
    const out = await repo.distinctLinkedCourseRefs();
    expect(Subject.distinct).toHaveBeenCalledWith('courseRef', { status: 'active', courseRef: { $ne: null } });
    expect(out).toEqual(['c1']);
  });

  test('resolveForSchedule : forme dénormalisée, campus-isolée', async () => {
    Subject.__setLean({ _id: 's1', subject_name: 'Maths', subject_code: 'MAT', coefficient: 2, department: 'd1' });
    const out = await repo.resolveForSchedule('s1', 'c1');
    expect(Subject.findOne).toHaveBeenCalledWith({ _id: 's1', schoolCampus: 'c1', status: { $ne: 'archived' } });
    expect(out).toEqual({ subjectId: 's1', subject_name: 'Maths', subject_code: 'MAT', coefficient: 2, department: 'd1' });
  });

  test('resolveForSchedule : subjectId vide → null sans requête', async () => {
    const out = await repo.resolveForSchedule(null, 'c1');
    expect(out).toBeNull();
    expect(Subject.findOne).not.toHaveBeenCalled();
  });

  test('getCampusRefsByIds : { _id:$in } + select schoolCampus (validation batch teacher)', async () => {
    Subject.__setLean([{ _id: 's1', schoolCampus: 'c1' }, { _id: 's2', schoolCampus: 'c1' }]);
    const out = await repo.getCampusRefsByIds(['s1', 's2'], { session: 'sx' });
    expect(Subject.find).toHaveBeenCalledWith({ _id: { $in: ['s1', 's2'] } });
    expect(out).toHaveLength(2);
  });
});
