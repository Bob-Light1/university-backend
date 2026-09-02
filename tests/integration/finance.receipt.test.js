'use strict';

/**
 * Integration smokes for the fee receipt route
 * (`GET /api/finance/payments/:id/receipt`) via Supertest.
 *
 * NO database: the service is stubbed, so what is verified here is everything
 * that happens BEFORE it — authentication, the role gate, the entitlement gate,
 * and above all the SCOPE the controller composes. That scope is the whole
 * isolation of this route: a campus filter for every caller, plus the caller's
 * own id when the caller is the student. A missing `student` key there is a
 * student downloading a classmate's receipt, and no unit test of the service
 * would see it — the service applies whatever scope it is handed.
 *
 * Design note: `docs/architecture/features/fee-receipts-and-reminders.md` §3, §5.
 */

delete process.env.AI_SERVICE_URL;
delete process.env.AI_SERVICE_SECRET;

// Only `getPaymentReceipt` is stubbed; the router, the guards and the
// controller stay real.
jest.mock('../../modules/finance/finance.service', () => ({
  ...jest.requireActual('../../modules/finance/finance.service'),
  getPaymentReceipt: jest.fn(),
}));

// The entitlement gate resolves the campus's plan before the router runs; the
// lookup is the only stubbed part (as in `entitlement.test.js`).
jest.mock('../../shared/lib/entitlement/entitlement.service', () => {
  const actual = jest.requireActual('../../shared/lib/entitlement/entitlement.service');
  return { ...actual, resolveForCampus: jest.fn() };
});

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const {
  FEATURE_STATES,
  FEATURE_PLANS,
  FEATURE_ERROR_CODES,
} = require('../../shared/constants/features.constants');
const { resolveEntitlement } = require('../../shared/utils/entitlement');
const entitlementService = require('../../shared/lib/entitlement/entitlement.service');
const financeService = require('../../modules/finance/finance.service');
const app = require('../../app');

const SECRET     = process.env.JWT_SECRET;
const USER_ID    = '507f1f77bcf86cd799439011';
const CAMPUS_ID  = '507f1f77bcf86cd799439012';
const OTHER_CAMPUS = '507f1f77bcf86cd799439013';
const PAYMENT_ID = '507f1f77bcf86cd799439abc';
const ROUTE      = `/api/finance/payments/${PAYMENT_ID}/receipt`;

/**
 * A fresh actor id per request by default.
 *
 * The receipt route carries a PER-USER render budget (see the last describe), so
 * a suite that signed every request as the same person would spend that budget
 * on its own setup and start reporting 429 for reasons that have nothing to do
 * with what it asserts. Tests that need to name the caller pass `id`.
 */
const freshId = () => crypto.randomBytes(12).toString('hex');

const tokenFor = (role, { id = freshId(), ...extra } = {}) =>
  jwt.sign({ id, role, ...extra }, SECRET, { issuer: 'school-management-app' });

const auth = (req, role, extra = { campusId: CAMPUS_ID }) =>
  req.set('Authorization', `Bearer ${tokenFor(role, extra)}`);

const RECEIPT = {
  buffer: Buffer.from('%PDF-1.4 receipt'),
  fileName: 'receipt-PAY-A-001.pdf',
  receiptNumber: 'PAY-A-001',
};

/** Makes the campus resolve to a plan (plus optional per-module overrides). */
const campusOn = (plan, modules = []) =>
  entitlementService.resolveForCampus.mockResolvedValue(resolveEntitlement({ plan, modules }));

beforeEach(() => {
  jest.clearAllMocks();
  campusOn(FEATURE_PLANS.PREMIUM);
  financeService.getPaymentReceipt.mockResolvedValue(RECEIPT);
});

describe('reçu — authentification et rôles', () => {
  test('sans jeton → 401, le service n\'est jamais atteint', async () => {
    const res = await request(app).get(ROUTE);
    expect(res.status).toBe(401);
    expect(financeService.getPaymentReceipt).not.toHaveBeenCalled();
  });

  test.each(['TEACHER', 'PARENT', 'MENTOR', 'STAFF'])(
    'un %s n\'a rien à faire sur un reçu → 403',
    async (role) => {
      const res = await auth(request(app).get(ROUTE), role);
      expect(res.status).toBe(403);
      expect(financeService.getPaymentReceipt).not.toHaveBeenCalled();
    },
  );

  test('un id de paiement malformé → 400, avant toute lecture', async () => {
    const res = await auth(request(app).get('/api/finance/payments/not-an-id/receipt'), 'CAMPUS_MANAGER');
    expect(res.status).toBe(400);
    expect(financeService.getPaymentReceipt).not.toHaveBeenCalled();
  });
});

describe('reçu — la portée composée par le contrôleur (§3)', () => {
  test('un CAMPUS_MANAGER lit dans SON campus, sans épingle d\'étudiant', async () => {
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');
    expect(res.status).toBe(200);
    expect(financeService.getPaymentReceipt).toHaveBeenCalledWith(PAYMENT_ID, { schoolCampus: CAMPUS_ID });
  });

  test('un STUDENT est épinglé sur SES propres encaissements', async () => {
    // Campus alone would let a student download a classmate's receipt: same
    // campus, another student. The two conditions are composed, never chosen
    // between.
    await auth(request(app).get(ROUTE), 'STUDENT', { id: USER_ID, campusId: CAMPUS_ID });
    expect(financeService.getPaymentReceipt).toHaveBeenCalledWith(PAYMENT_ID, {
      schoolCampus: CAMPUS_ID,
      student: USER_ID,
    });
  });

  test('un STUDENT ne peut pas élargir sa portée par la requête', async () => {
    await auth(request(app).get(`${ROUTE}?campusId=${OTHER_CAMPUS}`), 'STUDENT', { id: USER_ID, campusId: CAMPUS_ID });
    expect(financeService.getPaymentReceipt).toHaveBeenCalledWith(PAYMENT_ID, {
      schoolCampus: CAMPUS_ID,
      student: USER_ID,
    });
  });

  test('un CAMPUS_MANAGER non plus — le campus vient du jeton, jamais de l\'URL', async () => {
    await auth(request(app).get(`${ROUTE}?campusId=${OTHER_CAMPUS}`), 'CAMPUS_MANAGER');
    expect(financeService.getPaymentReceipt).toHaveBeenCalledWith(PAYMENT_ID, { schoolCampus: CAMPUS_ID });
  });

  test('un rôle local sans campus dans le jeton → 403, jamais une portée vide', async () => {
    // Fail closed: an empty filter here would read every campus's receipts.
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER', {});
    expect(res.status).toBe(403);
    expect(financeService.getPaymentReceipt).not.toHaveBeenCalled();
  });

  test('un ADMIN traverse les campus, et peut viser le sien par la requête', async () => {
    await auth(request(app).get(ROUTE), 'ADMIN', {});
    expect(financeService.getPaymentReceipt).toHaveBeenCalledWith(PAYMENT_ID, {});

    await auth(request(app).get(`${ROUTE}?campusId=${OTHER_CAMPUS}`), 'ADMIN', {});
    expect(financeService.getPaymentReceipt).toHaveBeenLastCalledWith(PAYMENT_ID, { schoolCampus: OTHER_CAMPUS });
  });
});

describe('reçu — la réponse', () => {
  test('un PDF en flux, avec son nom de fichier', async () => {
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="receipt-PAY-A-001.pdf"');
    expect(res.headers['content-length']).toBe(String(RECEIPT.buffer.length));
    expect(res.body.toString()).toBe('%PDF-1.4 receipt');
  });

  test('le nom du fichier survit au cross-origin — l\'en-tête est EXPOSÉ', async () => {
    // The SPA and the API never share an origin — front on Vercel and API
    // elsewhere in production, :5173 against :5000 in the visual harness. A
    // response header the API does not list in `Access-Control-Expose-Headers`
    // is invisible to the SPA's JavaScript, so `saveBlobResponse` reads
    // `undefined`, falls back to `receipt-<paymentId>.pdf`, and the receipt
    // NUMBER the server took care to compute never reaches the disk.
    //
    // Asserting the header is SENT (the test above) says nothing about that:
    // supertest is same-origin and reads every header. This one was found in a
    // browser, at the design note's browser-QA step — see its §9⑲.
    const res = await auth(request(app).get(ROUTE).set('Origin', 'http://localhost:5173'), 'CAMPUS_MANAGER');

    expect(res.status).toBe(200);
    expect((res.headers['access-control-expose-headers'] || '').split(/,\s*/))
      .toEqual(expect.arrayContaining(['Content-Disposition']));
  });

  test('hors portée : 404, jamais 403 — un 403 confirmerait que la ligne existe', async () => {
    financeService.getPaymentReceipt.mockResolvedValue(null);
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.success).toBe(false);
  });

  test('un paiement inconnu et un paiement d\'un autre campus sont indiscernables', async () => {
    financeService.getPaymentReceipt.mockResolvedValue(null);
    const unknown = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');
    const foreign = await auth(request(app).get(`/api/finance/payments/${CAMPUS_ID}/receipt`), 'CAMPUS_MANAGER');
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body.message).toBe(foreign.body.message);
  });
});

describe('reçu — les trois états d\'entitlement (§5)', () => {
  test('`enabled` : servi', async () => {
    campusOn(FEATURE_PLANS.PREMIUM);
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');
    expect(res.status).toBe(200);
  });

  test('`read_only` : SERVI — le reçu est une lecture, l\'historique reste lisible', async () => {
    // The note claims this by construction (the gate lets GET through in
    // read_only). Claimed is not verified: a receipt is precisely the document a
    // campus still needs while its subscription is suspended.
    campusOn(FEATURE_PLANS.PREMIUM, [{ key: 'finance', state: FEATURE_STATES.READ_ONLY }]);
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  test('`hidden` : refusé par la porte, avec son code dédié', async () => {
    campusOn(FEATURE_PLANS.PREMIUM, [{ key: 'finance', state: FEATURE_STATES.HIDDEN }]);
    const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(FEATURE_ERROR_CODES.DISABLED);
    expect(financeService.getPaymentReceipt).not.toHaveBeenCalled();
  });

  test('un ADMIN traverse la porte même sur un campus éteint (rôle global)', async () => {
    campusOn(FEATURE_PLANS.FREE, [{ key: 'finance', state: FEATURE_STATES.HIDDEN }]);
    const res = await auth(request(app).get(ROUTE), 'ADMIN', {});
    expect(res.status).toBe(200);
  });
});

describe('reçu — le budget de rendu (audit de l\'étape 7)', () => {
  test('un rendu PDF n\'est pas une lecture JSON : budget par utilisateur, pas le quota générique', async () => {
    // This route is the platform's third Puppeteer entry point and the only one
    // a STUDENT can reach. The pool caps CONCURRENCY (four pages), not arrival
    // rate: past that cap renders queue, so a burst here delays the print-queue
    // worker and the GED exports — which is why those already sit behind a
    // per-user PDF budget rather than the per-IP API one.
    const id = freshId();
    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER', { id, campusId: CAMPUS_ID });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).toBe(200);
  });

  test('le budget est propre à chaque utilisateur, pas à l\'adresse IP', async () => {
    // Keyed per IP, a campus office behind one NAT address would share a single
    // budget across every cashier — the first one to print would silence the rest.
    const spent = freshId();
    for (let i = 0; i < 7; i += 1) {
      await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER', { id: spent, campusId: CAMPUS_ID });
    }
    const other = await auth(request(app).get(ROUTE), 'CAMPUS_MANAGER', { id: freshId(), campusId: CAMPUS_ID });
    expect(other.status).toBe(200);
  });
});
