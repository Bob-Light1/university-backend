'use strict';

/**
 * Isolation campus sur la réinitialisation de mot de passe (B6-③).
 *
 * Le défaut, présent à l'identique dans `teacher.controller.js` ET
 * `student.controller.js` (le plan n'en signalait qu'un) :
 *   - `CAMPUS_MANAGER` était plié dans un booléen `isAdmin` ;
 *   - la cible était résolue par `findById(id)`, sans aucun filtre campus ;
 *   - la preuve du mot de passe actuel était sautée pour tout `isAdmin`.
 *
 * Composés, les trois donnent une prise de contrôle de compte INTER-TENANT : un
 * gestionnaire du campus A réinitialise le mot de passe d'un enseignant du campus
 * B, puis se connecte à sa place. C'est la frontière que CLAUDE.md §2 déclare non
 * négociable.
 *
 * Les assertions portent sur le FILTRE réellement envoyé à Mongo, parce que c'est
 * lui — et non le contrôle de rôle — qui décide de ce que l'appelant atteint.
 */

jest.mock('bcrypt', () => ({
  hash:    jest.fn().mockResolvedValue('$2b$12$hashed'),
  compare: jest.fn(),
  genSalt: jest.fn().mockResolvedValue('salt'),
}));

const bcrypt     = require('bcrypt');
const profileSvc = require('../../shared/services/profile.service');

const CAMPUS_A = '507f1f77bcf86cd799439011';
const CAMPUS_B = '507f1f77bcf86cd799439022';
const TARGET   = '507f1f77bcf86cd7994390aa';

/** Modèle Mongoose factice qui n'existe QUE sur le campus A. */
function fakeModel(name, { campus = CAMPUS_A } = {}) {
  const doc = { _id: TARGET, schoolCampus: campus, password: '$2b$12$stored' };
  const Model = {
    modelName: name,
    findOne: jest.fn((filter) => ({
      select: jest.fn().mockResolvedValue(
        // Reproduit la sémantique de Mongo : un filtre campus qui ne correspond
        // pas ne rend rien. Sans filtre du tout, le document est TOUJOURS rendu —
        // c'est exactement ce que faisait findById(id).
        (filter.schoolCampus && String(filter.schoolCampus) !== campus) ? null : doc,
      ),
    })),
    findByIdAndUpdate: jest.fn().mockResolvedValue(doc),
  };
  return { Model, doc };
}

/** Réponse Express factice. */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json   = jest.fn((body) => { res.body = body; return res; });
  return res;
}

const STRONG = 'Nouveau@Mdp2026';

beforeEach(() => {
  jest.clearAllMocks();
  bcrypt.compare.mockResolvedValue(true);
});

describe('resetManagedPassword — le filtre campus est le contrôle', () => {
  test('un gestionnaire du campus B ne peut PAS toucher une cible du campus A', async () => {
    const { Model } = fakeModel('Teacher', { campus: CAMPUS_A });
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model,
      { _id: TARGET, schoolCampus: CAMPUS_B },   // ce que buildCampusFilter produit
      { newPassword: STRONG },
      { actorIsTarget: false },
    );

    expect(Model.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  test('la cible hors campus rend 404, jamais 403 — un 403 confirmerait qu’elle existe', async () => {
    const { Model } = fakeModel('Student', { campus: CAMPUS_A });
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_B },
      { newPassword: STRONG }, { actorIsTarget: false },
    );

    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  test('un gestionnaire du même campus réinitialise sans le mot de passe actuel', async () => {
    const { Model } = fakeModel('Teacher', { campus: CAMPUS_A });
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      { newPassword: STRONG }, { actorIsTarget: false },
    );

    expect(Model.findByIdAndUpdate).toHaveBeenCalledWith(TARGET, { password: '$2b$12$hashed' });
    expect(bcrypt.compare).not.toHaveBeenCalled(); // c'est le sens d'une réinit administrative
    expect(res.statusCode).toBe(200);
  });

  test('un rôle global (filtre vide) atteint tous les campus — délibéré', async () => {
    const { Model } = fakeModel('Teacher', { campus: CAMPUS_B });
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET },   // buildCampusFilter rend {} pour ADMIN/DIRECTOR
      { newPassword: STRONG }, { actorIsTarget: false },
    );

    expect(res.statusCode).toBe(200);
  });
});

describe('resetManagedPassword — la preuve du mot de passe actuel', () => {
  test('l’acteur qui change SON mot de passe doit le prouver', async () => {
    const { Model } = fakeModel('Teacher');
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      { newPassword: STRONG },                       // pas de currentPassword
      { actorIsTarget: true },
    );

    expect(res.statusCode).toBe(400);
    expect(Model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('un mot de passe actuel faux est refusé en 401', async () => {
    const { Model } = fakeModel('Teacher');
    const res = fakeRes();
    bcrypt.compare.mockResolvedValue(false);

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      { currentPassword: 'faux', newPassword: STRONG },
      { actorIsTarget: true },
    );

    expect(res.statusCode).toBe(401);
    expect(Model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('un gestionnaire n’est PAS dispensé de prouver son propre mot de passe', async () => {
    // L'ancien code sautait la preuve dès que le rôle était « admin », y compris
    // quand l'admin agissait sur lui-même. Le rôle ne dispense de rien ici.
    const { Model } = fakeModel('Teacher');
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      { newPassword: STRONG },
      { actorIsTarget: true },                       // acteur == cible, rôle gestionnaire
    );

    expect(res.statusCode).toBe(400);
  });
});

describe('resetManagedPassword — validation', () => {
  test('un mot de passe faible est refusé avant toute lecture', async () => {
    const { Model } = fakeModel('Teacher');
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      { newPassword: '123' }, { actorIsTarget: false },
    );

    expect(res.statusCode).toBe(400);
    expect(Model.findOne).not.toHaveBeenCalled();
  });

  test('newPassword absent est refusé', async () => {
    const { Model } = fakeModel('Teacher');
    const res = fakeRes();

    await profileSvc.resetManagedPassword(
      res, Model, { _id: TARGET, schoolCampus: CAMPUS_A },
      {}, { actorIsTarget: false },
    );

    expect(res.statusCode).toBe(400);
  });
});

describe('les deux contrôleurs passent bien un filtre campus (B6-③)', () => {
  // Le service ne peut pas se protéger d'un appelant qui lui donne { _id } seul :
  // c'est le contrôleur qui doit dériver le scope. On l'épingle des deux côtés.
  const SOURCES = [
    ['teacher', require('fs').readFileSync(
      require('path').join(__dirname, '../../modules/teacher/controllers/teacher.controller.js'), 'utf8')],
    ['student', require('fs').readFileSync(
      require('path').join(__dirname, '../../modules/student/controllers/student.controller.js'), 'utf8')],
  ];

  test.each(SOURCES)('%s.controller dérive le filtre via buildCampusFilter', (_name, source) => {
    expect(source).toMatch(/buildCampusFilter\(req\.user\)/);
    expect(source).toMatch(/resetManagedPassword/);
  });

  test.each(SOURCES)('%s.controller ne replie plus CAMPUS_MANAGER dans un booléen isAdmin', (_name, source) => {
    expect(source).not.toMatch(/isAdmin\s*=\s*\[[^\]]*CAMPUS_MANAGER/);
  });

  test.each(SOURCES)('%s.controller ne résout plus la cible par id nu', (_name, source) => {
    expect(source).not.toMatch(/find\w*ByIdWithPassword\(id\)/);
  });
});
