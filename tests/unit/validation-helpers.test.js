'use strict';

/**
 * Tests des fonctions PURES de shared/utils/validation-helpers.
 * Aucune dépendance (ni model, ni DB) — ce sont des gardes de sécurité
 * multi-tenant et de validation d'entrée déplacées ici lors du chantier 20b (C0a).
 */

const {
  isValidObjectId,
  areValidObjectIds,
  isValidEmail,
  isValidPhone,
  validatePasswordStrength,
  canAccessCampus,
  buildCampusFilter,
  isResourceOwner,
  escapeRegex,
  sanitizeInput,
  isDateNotFuture,
} = require('../../shared/utils/validation-helpers');

describe('isValidObjectId / areValidObjectIds', () => {
  const oid = '507f1f77bcf86cd799439011';
  test('accepte un ObjectId valide', () => expect(isValidObjectId(oid)).toBe(true));
  test('rejette une chaîne non-ObjectId', () => expect(isValidObjectId('abc')).toBe(false));
  test('areValidObjectIds : tableau homogène valide', () => expect(areValidObjectIds([oid, oid])).toBe(true));
  test('areValidObjectIds : un élément invalide → false', () => expect(areValidObjectIds([oid, 'nope'])).toBe(false));
  test('areValidObjectIds : non-tableau → false', () => expect(areValidObjectIds('x')).toBe(false));
});

describe('isValidEmail / isValidPhone', () => {
  test('email valide', () => expect(isValidEmail('a.b+c@example.co')).toBe(true));
  test('email invalide', () => expect(isValidEmail('not-an-email')).toBe(false));
  test('téléphone valide', () => expect(isValidPhone('+237 677 12 34 56')).toBe(true));
  test('téléphone invalide', () => expect(isValidPhone('123')).toBe(false));
});

describe('validatePasswordStrength', () => {
  test('mot de passe conforme', () => {
    expect(validatePasswordStrength('Abcd1234!').valid).toBe(true);
  });
  test('trop court → erreurs', () => {
    const r = validatePasswordStrength('Ab1!');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  test('sans majuscule / chiffre / symbole → invalide', () => {
    expect(validatePasswordStrength('abcdefgh').valid).toBe(false);
  });
  test('avec espace → invalide', () => {
    expect(validatePasswordStrength('Abcd 123!').valid).toBe(false);
  });
});

describe('canAccessCampus', () => {
  const campus = '507f1f77bcf86cd799439011';
  test('ADMIN accède à tout', () => expect(canAccessCampus({ role: 'ADMIN' }, campus)).toBe(true));
  test('DIRECTOR accède à tout', () => expect(canAccessCampus({ role: 'DIRECTOR' }, campus)).toBe(true));
  test('CAMPUS_MANAGER limité à son campus', () => {
    expect(canAccessCampus({ role: 'CAMPUS_MANAGER', campusId: campus }, campus)).toBe(true);
    expect(canAccessCampus({ role: 'CAMPUS_MANAGER', campusId: 'other' }, campus)).toBe(false);
  });
});

describe('buildCampusFilter (frontière d isolation multi-tenant)', () => {
  const campus = '507f1f77bcf86cd799439011';
  test('ADMIN sans campus demandé → filtre vide (accès global)', () => {
    expect(buildCampusFilter({ role: 'ADMIN' })).toEqual({});
  });
  test('ADMIN avec campus demandé valide → filtre ciblé', () => {
    expect(buildCampusFilter({ role: 'DIRECTOR' }, campus)).toEqual({ schoolCampus: campus });
  });
  test('rôle non-global avec campusId → filtre verrouillé', () => {
    expect(buildCampusFilter({ role: 'TEACHER', campusId: campus })).toEqual({ schoolCampus: campus });
  });
  test('rôle non-global SANS campusId valide → throw (anti-fuite)', () => {
    expect(() => buildCampusFilter({ role: 'TEACHER' })).toThrow(/Campus isolation breach/);
  });
});

describe('escapeRegex (anti-injection regex)', () => {
  test('échappe les métacaractères', () => {
    expect(escapeRegex('a.b*c+')).toBe('a\\.b\\*c\\+');
  });
  test('null/undefined → chaîne vide', () => {
    expect(escapeRegex(null)).toBe('');
    expect(escapeRegex(undefined)).toBe('');
  });
  test('une regex échappée matche le littéral, pas le motif', () => {
    const rx = new RegExp(escapeRegex('a.c'));
    expect(rx.test('a.c')).toBe(true);
    expect(rx.test('axc')).toBe(false);
  });
});

describe('isResourceOwner', () => {
  test('même id → true', () => expect(isResourceOwner({ id: 'u1' }, 'u1')).toBe(true));
  test('id différent → false', () => expect(isResourceOwner({ id: 'u1' }, 'u2')).toBe(false));
  test('user sans id → false', () => expect(isResourceOwner({}, 'u1')).toBe(false));
});

describe('sanitizeInput / isDateNotFuture', () => {
  test('retire les chevrons et protocoles dangereux', () => {
    expect(sanitizeInput('<b>x</b>')).toBe('bx/b');
    expect(sanitizeInput('javascript:alert(1)')).toBe('alert(1)');
  });
  test('non-string renvoyé tel quel', () => expect(sanitizeInput(42)).toBe(42));
  test('date passée → true, future → false', () => {
    expect(isDateNotFuture(new Date('2000-01-01'))).toBe(true);
    expect(isDateNotFuture(new Date(Date.now() + 86400000))).toBe(false);
  });
});
