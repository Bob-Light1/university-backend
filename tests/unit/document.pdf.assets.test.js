'use strict';

/**
 * Service PDF GED — inlining des binaires dans le template (B8-⑤).
 *
 * Puppeteer charge le template via `setContent`, qui n'a pas d'URL de base : un
 * `src` qui n'est pas une data: URI ne rend rien. Le template émettait
 * `<img src="">` + un attribut `data-file` destiné à une étape de post-traitement
 * qui n'a jamais été écrite (deux écritures, zéro lecture) — donc **toutes** les
 * images et **tous** les QR de vérification des PDF générés sortaient vides.
 *
 * Les assertions décisives portent sur le HTML rendu, pas sur l'existence des
 * fichiers : c'est le HTML qui atteint Chromium.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs').promises;

// UPLOAD_DIR est lu à la charge du module — il doit être posé AVANT le require.
const TMP_ROOT = path.join(os.tmpdir(), `ged-pdf-assets-${process.pid}`);
process.env.UPLOAD_DIR = TMP_ROOT;

const { renderBlock, resolveDocumentAssets, buildHtmlTemplate } =
  require('../../modules/document/services/document.pdf.service');

const CAMPUS_ID  = '507f1f77bcf86cd799439011';
const IMAGES_DIR = path.join(TMP_ROOT, 'documents', CAMPUS_ID, 'images');

// PNG 1×1 valide — assez pour être lu, encodé et comparé.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, 'photo.png'), PNG_1PX);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

const imageBlock = (over = {}) => ({
  type: 'IMAGE', order: 0,
  content: { fileName: 'photo.png', alt: 'Portrait', ...over },
});

const qrBlock = (over = {}) => ({
  type: 'QR_CODE', order: 1,
  content: { label: 'Verify', ...over },
});

describe('renderBlock — plus aucun attribut adressé à personne (B8-⑤)', () => {
  test('IMAGE : la data: URI résolue devient le src', () => {
    const assets = { images: new Map([['photo.png', 'data:image/png;base64,AAAA']]), qrCodes: new Map() };

    const html = renderBlock(imageBlock(), assets);

    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="Portrait"');
    // Les deux formes du bug.
    expect(html).not.toContain('src=""');
    expect(html).not.toContain('data-file');
  });

  test('QR_CODE : un <img> réel, plus un <div> vide dimensionné', () => {
    const assets = { images: new Map(), qrCodes: new Map([[80, 'data:image/png;base64,QQQQ']]) };

    const html = renderBlock(qrBlock(), assets);

    expect(html).toContain('<img src="data:image/png;base64,QQQQ"');
    expect(html).toContain('width="80" height="80"');
    expect(html).not.toContain('data-qr-file');
  });

  test('QR_CODE : la taille du bloc sélectionne la bonne data: URI', () => {
    const assets = { images: new Map(), qrCodes: new Map([[80, 'data:URI-80'], [200, 'data:URI-200']]) };

    expect(renderBlock(qrBlock({ size: 200 }), assets)).toContain('data:URI-200');
    expect(renderBlock(qrBlock(), assets)).toContain('data:URI-80');
  });

  test('un binaire non résolu rend un placeholder VISIBLE, pas un blanc silencieux', () => {
    const empty = { images: new Map(), qrCodes: new Map() };

    const img = renderBlock(imageBlock(), empty);
    const qr  = renderBlock(qrBlock(), empty);

    expect(img).toContain('asset-missing');
    expect(img).toContain('photo.png');       // le nom reste diagnostiquable
    expect(img).not.toContain('<img');        // surtout pas un <img> vide de plus
    expect(qr).toContain('asset-missing');
  });

  test('sans assets du tout, le rendu ne lève pas (chemin par défaut)', () => {
    expect(() => renderBlock(imageBlock())).not.toThrow();
    expect(renderBlock(qrBlock())).toContain('asset-missing');
  });
});

describe('resolveDocumentAssets — lecture réelle du stockage par campus', () => {
  test('une image stockée est lue et encodée en data: URI', async () => {
    const doc = { campusId: CAMPUS_ID, ref: 'DOC-2026-X-ABCD1234', body: [imageBlock()] };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.images.get('photo.png')).toBe(`data:image/png;base64,${PNG_1PX.toString('base64')}`);
  });

  test('un QR est régénéré depuis doc.ref — aucune lecture disque requise', async () => {
    const doc = { campusId: CAMPUS_ID, ref: 'DOC-2026-X-ABCD1234', body: [qrBlock({ size: 120 })] };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.qrCodes.get(120)).toMatch(/^data:image\/png;base64,/);
  });

  test('un fichier absent ne fait pas échouer la génération du document entier', async () => {
    const doc = { campusId: CAMPUS_ID, ref: 'DOC-1', body: [imageBlock({ fileName: 'ghost.png' })] };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.images.size).toBe(0);
  });

  test('un nom de fichier porteur d’un séparateur est refusé, jamais lu', async () => {
    const doc = {
      campusId: CAMPUS_ID, ref: 'DOC-1',
      body: [
        imageBlock({ fileName: '../pdf/secret.png' }),
        imageBlock({ fileName: '/etc/passwd' }),
      ],
    };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.images.size).toBe(0);
  });

  test('une extension non inlineable est refusée', async () => {
    await fs.writeFile(path.join(IMAGES_DIR, 'payload.html'), '<script>x</script>');
    const doc = { campusId: CAMPUS_ID, ref: 'DOC-1', body: [imageBlock({ fileName: 'payload.html' })] };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.images.size).toBe(0);
  });

  test('un document sans ref (prévisualisation de template) ne génère pas de QR', async () => {
    const doc = { campusId: CAMPUS_ID, ref: null, body: [qrBlock()] };

    const assets = await resolveDocumentAssets(doc);

    expect(assets.qrCodes.size).toBe(0);
  });
});

describe('buildHtmlTemplate — le HTML remis à Chromium', () => {
  test('le document complet embarque l’image et le QR, et plus aucun src vide', async () => {
    const doc = {
      title: 'Attestation', ref: 'DOC-2026-X-ABCD1234', campusId: CAMPUS_ID,
      body: [imageBlock(), qrBlock()],
    };

    const html = buildHtmlTemplate(doc, 'Campus Nord', await resolveDocumentAssets(doc));

    expect(html).toContain(`data:image/png;base64,${PNG_1PX.toString('base64')}`);
    expect(html).toMatch(/<div class="qr-code"[^>]*><img src="data:image\/png;base64,/);
    expect(html).not.toContain('src=""');
    expect(html).not.toContain('data-file');
    expect(html).not.toContain('data-qr-file');
  });
});
