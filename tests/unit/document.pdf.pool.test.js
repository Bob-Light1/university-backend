'use strict';

/**
 * Service PDF GED — pool Puppeteer et sémantique du timeout (B8-② / B8-③).
 *
 * Deux défauts dans la même fonction :
 *   ② `release()` était appelé sur le chemin du timeout ET dans le `finally` → le
 *      même navigateur repoussé deux fois, la borne du pool détruite, deux
 *      générations concurrentes pilotant un seul navigateur.
 *   ③ rejeter la promesse de l'appelant n'arrête pas le travail derrière : la
 *      génération expirée écrivait quand même le fichier et appelait
 *      `setPdfSnapshot` des secondes plus tard.
 *
 * Les assertions portent donc sur des effets OBSERVABLES — la concurrence réelle
 * de pages ouvertes, et l'absence d'écriture — jamais sur des compteurs internes.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs').promises;

// Tous lus à la charge du module.
const TMP_ROOT = path.join(os.tmpdir(), `ged-pdf-pool-${process.pid}`);
process.env.UPLOAD_DIR                 = TMP_ROOT;
process.env.PUPPETEER_POOL_SIZE        = '1';
process.env.PUPPETEER_TIMEOUT_MS       = '80';
process.env.PUPPETEER_EXECUTABLE_PATH  = '/nonexistent/chrome'; // jamais lancé : puppeteer est mocké

// ── Doublures ────────────────────────────────────────────────────────────────

// Les doublures Jest ne peuvent référencer que des variables préfixées `mock`.

/** Pages actuellement ouvertes, tous navigateurs confondus, et le pic atteint. */
const mockPageTracker = { open: 0, peak: 0 };

/** Comportement de `page.pdf()` pour le prochain job — piloté par chaque test. */
const mockPdf = { behaviour: async () => Buffer.from('%PDF-1.4 fake') };

jest.mock('@sparticuz/chromium', () => ({
  headless: true, args: [], defaultViewport: null,
  executablePath: async () => '/nonexistent/chrome',
}));

jest.mock('puppeteer-core', () => ({
  launch: jest.fn(async () => ({
    newPage: async () => {
      mockPageTracker.open += 1;
      mockPageTracker.peak = Math.max(mockPageTracker.peak, mockPageTracker.open);
      let closed = false;
      return {
        setContent: async () => {},
        pdf:        () => mockPdf.behaviour(),
        close:      async () => { if (!closed) { closed = true; mockPageTracker.open -= 1; } },
      };
    },
    close: async () => {},
  })),
}));

jest.mock('../../modules/document/document.repository');

const repo = require('../../modules/document/document.repository');
const pdfService = require('../../modules/document/services/document.pdf.service');

const CAMPUS_ID = '507f1f77bcf86cd799439011';

const fakeDoc = {
  _id: 'doc-1', ref: 'DOC-2026-X-ABCD1234', title: 'Attestation',
  campusId: CAMPUS_ID, currentVersion: 3, body: [], branding: {}, printConfig: {},
};

/** Résout après `ms`, comme une génération lente qui finit malgré tout. */
const slowPdf = (ms) => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return Buffer.from('%PDF-1.4 late');
};

const pdfDir = path.join(TMP_ROOT, 'documents', CAMPUS_ID, 'pdf');

beforeEach(() => {
  jest.clearAllMocks();
  mockPageTracker.open = 0;
  mockPageTracker.peak = 0;
  mockPdf.behaviour = async () => Buffer.from('%PDF-1.4 fake');
  repo.findDocumentForPdf.mockResolvedValue(fakeDoc);
  repo.setPdfSnapshot.mockResolvedValue(undefined);
});

afterAll(async () => {
  await pdfService.shutdownPool();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe('generateDocumentPdf — chemin nominal', () => {
  test('écrit le PDF, met à jour pdfSnapshot et rend le navigateur', async () => {
    const out = await pdfService.generateDocumentPdf('doc-1', 'ver-9', 'Campus Nord');

    expect(out.fileName).toBe('DOC-2026-X-ABCD1234_v3_ver-9.pdf');
    expect(repo.setPdfSnapshot).toHaveBeenCalledWith('doc-1', out.fileName);
    await expect(fs.access(path.join(pdfDir, out.fileName))).resolves.toBeUndefined();
    expect(mockPageTracker.open).toBe(0); // aucune page laissée ouverte
  });
});

describe('B8-③ — une génération expirée n’écrit RIEN', () => {
  test('ni fichier PDF, ni setPdfSnapshot, même après la fin tardive du travail', async () => {
    // Le rendu dépasse le timeout (80 ms) mais finit quand même : c'est
    // exactement le scénario où l'ancienne version écrivait après le 503.
    mockPdf.behaviour = slowPdf(250);

    await expect(pdfService.generateDocumentPdf('doc-1', 'ver-late', 'Campus Nord'))
      .rejects.toMatchObject({ statusCode: 503 });

    // Laisser le travail de fond se terminer et tenter d'écrire.
    await new Promise((r) => setTimeout(r, 350));

    expect(repo.setPdfSnapshot).not.toHaveBeenCalled();
    await expect(fs.access(path.join(pdfDir, 'DOC-2026-X-ABCD1234_v3_ver-late.pdf')))
      .rejects.toThrow();
  });

  test('le 503 n’est pas écrasé par l’erreur que l’annulation provoque', async () => {
    mockPdf.behaviour = async () => { await new Promise((r) => setTimeout(r, 200)); throw new Error('page closed'); };

    const err = await pdfService.generateDocumentPdf('doc-1', 'v', 'C').catch((e) => e);

    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/timed out/);
  });
});

describe('B8-② — la borne du pool survit à un timeout', () => {
  test('après une génération expirée, deux jobs concurrents restent sérialisés', async () => {
    // 1. Un job qui expire. Avec le double release, le navigateur revient DEUX
    //    fois dans un pool dimensionné à 1.
    mockPdf.behaviour = slowPdf(250);
    await expect(pdfService.generateDocumentPdf('doc-1', 'v-timeout', 'C'))
      .rejects.toMatchObject({ statusCode: 503 });
    await new Promise((r) => setTimeout(r, 350)); // le travail de fond se termine et libère

    // 2. Deux générations concurrentes sur un pool de taille 1.
    mockPageTracker.peak = 0;
    mockPdf.behaviour = slowPdf(60);

    await Promise.all([
      pdfService.generateDocumentPdf('doc-1', 'v-a', 'C'),
      pdfService.generateDocumentPdf('doc-1', 'v-b', 'C'),
    ]);

    // POOL_SIZE = 1 : jamais plus d'une page ouverte à la fois. Avec le double
    // release, le pool en contient deux et les deux jobs démarrent ensemble.
    expect(mockPageTracker.peak).toBe(1);
  });

  // Ce test s'exécute APRÈS celui du timeout, délibérément : le pool est un état
  // de module, donc une corruption ne se répare pas au job suivant — elle tient
  // jusqu'au redémarrage. Isolé, il passe même contre le code d'origine ; en
  // séquence, il échoue, et c'est précisément ce que « la borne du pool est
  // détruite » veut dire en production.
  test('la corruption survit au job suivant : un échec ordinaire trouve un pool déjà cassé', async () => {
    mockPdf.behaviour = async () => { throw new Error('render exploded'); };

    await expect(pdfService.generateDocumentPdf('doc-1', 'v-err', 'C'))
      .rejects.toThrow('render exploded');

    // Le pool est intact : deux jobs suivants restent sérialisés.
    mockPageTracker.peak = 0;
    mockPdf.behaviour = slowPdf(60);
    await Promise.all([
      pdfService.generateDocumentPdf('doc-1', 'v-c', 'C'),
      pdfService.generateDocumentPdf('doc-1', 'v-d', 'C'),
    ]);

    expect(mockPageTracker.peak).toBe(1);
  });
});
