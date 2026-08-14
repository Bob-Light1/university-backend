'use strict';

/**
 * Stockage GED — dispatch de backend et étanchéité de l'abstraction (B8-①).
 *
 * Le défaut n'était pas « la GED écrit sur disque ». C'était que le service de
 * stockage PROMETTAIT d'être échangeable — « Phase 3+: S3 / GCS via same interface
 * without controller changes » — alors que la moitié des E/S le contournait :
 *
 *   - `document.pdf.service.js` écrivait le snapshot PDF en `fs.writeFile` direct,
 *     le relisait en `fs.readFile` direct, et lisait les images de bloc pareil ;
 *   - `document.qr.service.js` écrivait un PNG en direct (et personne ne l'appelait).
 *
 * Échanger le backend aurait donc migré le fichier importé et laissé les PDF et les
 * images sur un disque éphémère — B8-① à moitié fermé, sans erreur ni log.
 *
 * Le test décisif de ce fichier est le balayage des E/S : il échoue tant qu'un
 * fichier du module document touche le système de fichiers hors des backends.
 * Les autres épinglent le dispatch et la construction de clé.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs').promises;

// Lu à la charge du backend local — doit être posé AVANT le require.
const TMP_ROOT = path.join(os.tmpdir(), `ged-storage-${process.pid}`);
process.env.UPLOAD_DIR = TMP_ROOT;

const storage = require('../../modules/document/services/document.storage.service');
const { resolveStorageProvider, STORAGE_PROVIDER } =
  require('../../shared/utils/storage-provider');

const CAMPUS_A = '507f1f77bcf86cd799439011';
const CAMPUS_B = '507f1f77bcf86cd799439022';

/** PNG 1×1 valide — magic bytes corrects, donc accepté par saveFile. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const pngUpload = (over = {}) => ({
  buffer:       PNG_1PX,
  mimetype:     'image/png',
  originalname: 'portrait.png',
  size:         PNG_1PX.length,
  ...over,
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

// ── Le test qui aurait attrapé B8-① tel qu'il était spécifié ─────────────────

describe('étanchéité : aucune E/S disque hors des backends de stockage', () => {
  /**
   * Fichiers du module document autorisés à toucher `fs`, et pourquoi.
   *
   * Une liste blanche, pas une liste noire : un nouveau fichier qui écrit en direct
   * fait échouer ce test tant qu'il n'est pas justifié ici. C'est la même logique
   * que le registre du hard delete — la zone dangereuse s'ouvre par déclaration.
   */
  const ALLOWED = new Map([
    // Le backend disque. C'est sa raison d'être.
    ['services/document.storage.local.js', 'the local backend itself'],
    // Artefact de durée de vie du PROCESSUS : le ZIP d'un print job est indexé par
    // une Map en mémoire qui meurt avec le processus, avec un TTL d'une heure. Un
    // objet distant pour un fichier que plus rien ne sait retrouver après un
    // redémarrage n'aurait aucun sens. Exception DÉCLARÉE, pas oubliée.
    ['controllers/document.export.controller.js', 'print-job ZIP: process-lifetime artifact, 1 h TTL'],
  ]);

  const MODULE_ROOT = path.join(__dirname, '../../modules/document');

  /** Chemins relatifs de tous les .js du module, récursivement. */
  const collectSources = async (dir, prefix = '') => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(...await collectSources(path.join(dir, entry.name), rel));
      } else if (entry.name.endsWith('.js')) {
        out.push(rel);
      }
    }
    return out;
  };

  // `require('fs')` sous toutes ses formes, y compris les requires paresseux en
  // milieu de fonction — c'est précisément la forme que prenaient les fuites.
  const FS_REQUIRE = /require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;

  test('aucun fichier non déclaré du module document ne require fs', async () => {
    const sources  = await collectSources(MODULE_ROOT);
    const offenders = [];

    for (const rel of sources) {
      const source = await fs.readFile(path.join(MODULE_ROOT, rel), 'utf8');
      if (FS_REQUIRE.test(source) && !ALLOWED.has(rel)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  test('le service PDF passe par le stockage — plus aucune écriture ni lecture directe', async () => {
    const source = await fs.readFile(
      path.join(MODULE_ROOT, 'services/document.pdf.service.js'), 'utf8',
    );

    expect(source).not.toMatch(FS_REQUIRE);
    expect(source).toMatch(/storage\.saveBuffer\(/);
    expect(source).toMatch(/storage\.readFile\(/);
  });

  test('le service QR n’écrit plus rien nulle part', async () => {
    const source = await fs.readFile(
      path.join(MODULE_ROOT, 'services/document.qr.service.js'), 'utf8',
    );

    expect(source).not.toMatch(FS_REQUIRE);
    // Le générateur sur disque avait zéro appelant : il ne doit pas revenir.
    expect(require('../../modules/document/services/document.qr.service').generateQrCode)
      .toBeUndefined();
  });
});

// ── Dispatch de backend ───────────────────────────────────────────────────────

describe('resolveStorageProvider — une seule décision, deux consommateurs', () => {
  test('hors production, disque local par défaut', () => {
    expect(resolveStorageProvider({ NODE_ENV: 'development' }))
      .toBe(STORAGE_PROVIDER.LOCAL);
  });

  test('en production avec les trois identifiants Cloudinary, object store', () => {
    expect(resolveStorageProvider({
      NODE_ENV: 'production',
      CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
    })).toBe(STORAGE_PROVIDER.CLOUDINARY);
  });

  test('en production SANS identifiants, on retombe sur local — et c’est le préflight qui refuse', () => {
    // Ne pas basculer silencieusement : le repli est explicite ici, et
    // assertPersistentStorage() exige alors un volume vérifié avant de démarrer.
    expect(resolveStorageProvider({ NODE_ENV: 'production' }))
      .toBe(STORAGE_PROVIDER.LOCAL);
  });

  test('un identifiant Cloudinary manquant ne suffit pas', () => {
    expect(resolveStorageProvider({
      NODE_ENV: 'production',
      CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', // pas de secret
    })).toBe(STORAGE_PROVIDER.LOCAL);
  });

  test('DOC_STORAGE_PROVIDER l’emporte dans les deux sens', () => {
    expect(resolveStorageProvider({
      NODE_ENV: 'production',
      CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
      DOC_STORAGE_PROVIDER: 'local',
    })).toBe(STORAGE_PROVIDER.LOCAL);

    expect(resolveStorageProvider({
      NODE_ENV: 'development', DOC_STORAGE_PROVIDER: 'cloudinary',
    })).toBe(STORAGE_PROVIDER.CLOUDINARY);
  });

  test('une valeur inconnue est ignorée, pas honorée', () => {
    // Une faute de frappe ne doit pas sélectionner un backend que personne n'a voulu.
    expect(resolveStorageProvider({ NODE_ENV: 'production', DOC_STORAGE_PROVIDER: 's3' }))
      .toBe(STORAGE_PROVIDER.LOCAL);
  });
});

// ── Construction de clé ───────────────────────────────────────────────────────

describe('buildKey — le seul endroit où une clé est fabriquée', () => {
  test('produit une clé neutre {campus}/{catégorie}/{fichier}', () => {
    expect(storage.buildKey(CAMPUS_A, 'imported', 'abc.pdf'))
      .toBe(`${CAMPUS_A}/imported/abc.pdf`);
  });

  test('refuse un nom de fichier qui n’est pas un basename', () => {
    // Les noms stockés sont des UUID, mais ils reviennent par le contenu des
    // documents et les corps de requête : un segment `..` adresserait un AUTRE campus.
    expect(() => storage.buildKey(CAMPUS_A, 'images', '../../etc/passwd'))
      .toThrow(/Invalid storage filename/);
    expect(() => storage.buildKey(CAMPUS_A, 'images', 'sub/dir/x.png'))
      .toThrow(/Invalid storage filename/);
  });

  test('refuse un campusId absent plutôt que d’écrire hors de tout campus', () => {
    expect(() => storage.buildKey(null, 'imported', 'a.pdf')).toThrow(/campusId is required/);
    expect(() => storage.buildKey('',   'imported', 'a.pdf')).toThrow(/campusId is required/);
  });

  test('un campusId traversant est réduit à son basename', () => {
    expect(storage.buildKey('../../root', 'pdf', 'a.pdf')).toBe('root/pdf/a.pdf');
  });
});

// ── Aller-retour réel sur le backend local ────────────────────────────────────

describe('backend local — aller-retour complet', () => {
  test('saveFile → readFile → deleteFile', async () => {
    const saved = await storage.saveFile(pngUpload(), CAMPUS_A, 'images');

    expect(saved.fileName).toMatch(/^[0-9a-f-]{36}\.png$/); // UUID, jamais le nom d'origine
    expect(saved.originalName).toBe('portrait.png');
    expect(saved.provider).toBe('local');

    const read = await storage.readFile(CAMPUS_A, 'images', saved.fileName);
    expect(Buffer.isBuffer(read)).toBe(true);

    expect(await storage.deleteFile(CAMPUS_A, 'images', saved.fileName)).toBe(true);
    expect(await storage.readFile(CAMPUS_A, 'images', saved.fileName)).toBeNull();
  });

  test('saveBuffer écrit sous le nom choisi par l’appelant', async () => {
    // Le nom d'un snapshot PDF encode la version : c'est ce qui rend un PDF en
    // cache sûr à servir, donc l'appelant doit le contrôler.
    const out = await storage.saveBuffer(Buffer.from('%PDF-1.4'), {
      campusId: CAMPUS_A, category: 'pdf', fileName: 'DOC-2026-X_v3_ver-9.pdf',
    });

    expect(out.fileName).toBe('DOC-2026-X_v3_ver-9.pdf');
    expect(await storage.readFile(CAMPUS_A, 'pdf', 'DOC-2026-X_v3_ver-9.pdf'))
      .toEqual(Buffer.from('%PDF-1.4'));
  });

  test('les campus ne se lisent pas entre eux', async () => {
    const saved = await storage.saveFile(pngUpload(), CAMPUS_A, 'images');

    expect(await storage.readFile(CAMPUS_B, 'images', saved.fileName)).toBeNull();
  });

  test('readFile rend null au-delà de maxBytes, sans rendre le tampon', async () => {
    const out = await storage.saveBuffer(Buffer.alloc(2048), {
      campusId: CAMPUS_A, category: 'images', fileName: 'big.png',
    });

    expect(await storage.readFile(CAMPUS_A, 'images', out.fileName, { maxBytes: 1024 })).toBeNull();
    expect(await storage.readFile(CAMPUS_A, 'images', out.fileName, { maxBytes: 4096 })).not.toBeNull();
  });

  test('readFile rend null sur un nom traversant au lieu de lever', async () => {
    // L'appelant (rendu PDF) doit dégrader en placeholder, pas planter la génération.
    expect(await storage.readFile(CAMPUS_A, 'images', '../../../etc/passwd')).toBeNull();
  });

  test('deleteFile rend false sur un fichier absent', async () => {
    expect(await storage.deleteFile(CAMPUS_A, 'imported', 'nothing-here.pdf')).toBe(false);
  });

  test('saveFile refuse un contenu qui ment sur son type', async () => {
    await expect(storage.saveFile(
      pngUpload({ buffer: Buffer.from('not a png at all'), originalname: 'fake.png' }),
      CAMPUS_A, 'images',
    )).rejects.toMatchObject({ statusCode: 422 });
  });
});
