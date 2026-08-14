'use strict';

/**
 * @file document.routes.guards.test.js
 * @description Regression tests for defects B7-④ and B7-⑤ — GED route wiring.
 *
 * Both defects are wiring, not logic: the middlewares involved are correct and were simply
 * mounted in the wrong order (B7-④) or not mounted at all (B7-⑤). So the assertions read
 * the router's own stack rather than a mock of it — that is where the defect lived.
 *
 * B7-④ — `enforceDocumentTypeAccess` ran BEFORE multer on PATCH. It reads `req.body.type`,
 *        which does not exist on a multipart request until multer has parsed it, and falls
 *        back to the type of the document already stored. The same request was therefore
 *        refused as JSON and accepted as multipart. POST, nine lines above, already ran
 *        multer first and carried a comment explaining exactly why.
 *
 * B7-⑤ — PATCH (and DELETE, which this plan did not record) mounted `withDoc`, not
 *        `withDocTeacher`: reads were scoped per role, writes were not. Any authenticated
 *        member of a campus could edit or delete any document of that campus — a STUDENT
 *        included, since `updateDocument` and `softDeleteDocument` check status, never
 *        identity.
 */

const router = require('../../modules/document/document.routes');
const {
  enforceDocumentTypeAccess,
} = require('../../modules/document/middleware/document.access.middleware');

/** Handler names, in mounted order, for one method+path of the router. */
const chainOf = (method, path) => {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`Route not mounted: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.name);
};

const indexOf = (chain, name) => chain.indexOf(name);

describe('B7-④ — the body is parsed before the guard that reads it', () => {
  test('PATCH /:id runs multer BEFORE enforceDocumentTypeAccess', () => {
    const chain = chainOf('patch', '/:id');

    const multer = indexOf(chain, 'multerMiddleware');
    const guard  = indexOf(chain, 'enforceDocumentTypeAccess');

    expect(multer).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(multer).toBeLessThan(guard);
  });

  test('POST / keeps the same order — the two routes must not drift apart', () => {
    const chain = chainOf('post', '/');

    expect(indexOf(chain, 'multerMiddleware'))
      .toBeLessThan(indexOf(chain, 'enforceDocumentTypeAccess'));
  });

  test('the mechanism: with no parsed body the guard falls back to the STORED type', () => {
    // This is why the order matters, and it is the half of the defect a wiring assertion
    // cannot show. A TEACHER retyping a COURSE_MATERIAL into a restricted type is refused
    // when the body is present…
    const next = jest.fn();
    const res  = { status: jest.fn(() => res), json: jest.fn(() => res) };

    enforceDocumentTypeAccess(
      { user: { role: 'TEACHER' }, body: { type: 'CONTRACT' }, document: { type: 'COURSE_MATERIAL' } },
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();

    // …and waved through when it is not, because the fallback reads the type already on
    // the document rather than the one the request is asking for.
    const next2 = jest.fn();
    enforceDocumentTypeAccess(
      { user: { role: 'TEACHER' }, body: undefined, document: { type: 'COURSE_MATERIAL' } },
      { status: jest.fn(), json: jest.fn() },
      next2,
    );
    expect(next2).toHaveBeenCalled();
  });
});

describe('B7-⑤ — a write is scoped exactly like the read it mirrors', () => {
  const SCOPE_GUARDS = ['enforceTeacherScope', 'enforceStudentScope', 'enforceParentScope'];

  test('GET /:id carries the three scope guards (unchanged reference)', () => {
    const chain = chainOf('get', '/:id');
    SCOPE_GUARDS.forEach((guard) => expect(chain).toContain(guard));
  });

  test('PATCH /:id carries the same three scope guards', () => {
    const chain = chainOf('patch', '/:id');
    SCOPE_GUARDS.forEach((guard) => expect(chain).toContain(guard));
  });

  test('DELETE /:id carries them too — the twin this plan did not record', () => {
    const chain = chainOf('delete', '/:id');
    SCOPE_GUARDS.forEach((guard) => expect(chain).toContain(guard));
  });

  test('the scope guards run before the document body is parsed', () => {
    // An unauthorized caller is refused without a 25 MB upload being read first.
    const chain = chainOf('patch', '/:id');
    SCOPE_GUARDS.forEach((guard) => {
      expect(indexOf(chain, guard)).toBeLessThan(indexOf(chain, 'multerMiddleware'));
    });
  });

  test('both write routes gate on a writer role', () => {
    // The scope guards narrow WHICH documents a role reaches; they do not decide that
    // STUDENT and PARENT hold the GED read-only. Without this gate a student could edit a
    // transcript linked to them and pass every scope guard on the way.
    ['patch', 'delete'].forEach((method) => {
      expect(chainOf(method, '/:id')).toContain('requireDocRole');
    });
  });

  test('the document is loaded before anything scopes on it', () => {
    ['patch', 'delete'].forEach((method) => {
      const chain = chainOf(method, '/:id');
      expect(indexOf(chain, 'loadAndVerifyDocument'))
        .toBeLessThan(indexOf(chain, 'enforceTeacherScope'));
    });
  });

  test('the lock guard survives on both write routes', () => {
    ['patch', 'delete'].forEach((method) => {
      expect(chainOf(method, '/:id')).toContain('enforceLockGuard');
    });
  });
});
