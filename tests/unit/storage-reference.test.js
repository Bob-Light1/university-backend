'use strict';

/**
 * Référence de stockage d'un fichier uploadé (B7-② / B7-③).
 *
 * ② `req.file.path` est un chemin absolu en développement et une URL Cloudinary
 *    en production : le persister brut écrit dans MongoDB le chemin d'un fichier
 *    situé sur le portable d'un développeur.
 * ③ `deleteFile(folder, entity.profileImage)` échouait de trois façons à la fois
 *    (mauvaise racine, mauvais argument, mauvais environnement) et rendait
 *    `false` au lieu de lever — donc `.catch()` gardait une promesse qui ne
 *    rejetait jamais, et aucune ancienne photo n'était jamais supprimée.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs').promises;

const TMP_ROOT = path.join(os.tmpdir(), `storage-ref-${process.pid}`);
process.env.UPLOAD_DIR = TMP_ROOT;
process.env.BASE_URL   = 'https://erp.example.test';

jest.mock('cloudinary', () => ({
  v2: {
    config:   jest.fn(),
    uploader: { destroy: jest.fn() },
  },
}));

const cloudinary = require('cloudinary').v2;
const {
  describeUploadedFile,
  removeStoredFile,
  discardPreviousUpload,
  STORAGE_PROVIDER,
} = require('../../shared/utils/storage-reference');

const localFile = (relative) => ({
  path:        path.join(TMP_ROOT, relative),
  destination: path.dirname(path.join(TMP_ROOT, relative)),
  filename:    path.basename(relative),
});

const cloudinaryFile = () => ({
  path:     'https://res.cloudinary.com/demo/image/upload/v1712345678/backend/students/rose-9f3c2a.png',
  filename: 'backend/students/rose-9f3c2a',
  size:     1234,
});

beforeAll(() => fs.mkdir(path.join(TMP_ROOT, 'students'), { recursive: true }));
afterAll(() => fs.rm(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 }));
beforeEach(() => jest.clearAllMocks());

describe('describeUploadedFile — une seule signification, quel que soit le backend (B7-②)', () => {
  test('fichier disque : URL publique + clé RELATIVE à UPLOAD_DIR', () => {
    const ref = describeUploadedFile(localFile('students/rose.png'));

    expect(ref.provider).toBe(STORAGE_PROVIDER.LOCAL);
    expect(ref.storageKey).toBe(path.join('students', 'rose.png'));
    // Le défaut : c'est CE chemin absolu qui atterrissait en base. L'URL est
    // construite depuis la clé relative, donc elle reste correcte même quand
    // UPLOAD_DIR ne se termine pas par « uploads » (ce que la réécriture par
    // sous-chaîne de getFileUrl ne sait pas faire).
    expect(ref.url).not.toContain(TMP_ROOT);
    expect(ref.url).toBe('https://erp.example.test/uploads/students/rose.png');
  });

  test('fichier Cloudinary : le public_id est repris verbatim, il contient déjà le dossier', () => {
    const ref = describeUploadedFile(cloudinaryFile());

    expect(ref.provider).toBe(STORAGE_PROVIDER.CLOUDINARY);
    expect(ref.storageKey).toBe('backend/students/rose-9f3c2a');
    expect(ref.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
  });

  test('le provider vient de la FORME du fichier, pas de NODE_ENV', () => {
    // uploadCampusImageMemory utilise memoryStorage en production : un fichier de
    // production peut n'être ni Cloudinary ni local. Relire l'environnement se
    // tromperait sur ce cas, qui existe déjà dans ce dépôt.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    expect(describeUploadedFile(localFile('students/x.png')).provider).toBe(STORAGE_PROVIDER.LOCAL);
    expect(describeUploadedFile({ buffer: Buffer.from('x'), size: 1 })).toEqual({
      provider: STORAGE_PROVIDER.MEMORY, url: null, storageKey: null,
    });

    process.env.NODE_ENV = previous;
  });

  test('aucun fichier → null (et non un objet vide qu’un appelant croirait valide)', () => {
    expect(describeUploadedFile(null)).toBeNull();
    expect(describeUploadedFile(undefined)).toBeNull();
  });
});

describe('removeStoredFile — supprimer ce qui a réellement été stocké (B7-③)', () => {
  test('local : le fichier est effectivement supprimé du disque', async () => {
    const target = path.join(TMP_ROOT, 'students', 'to-delete.png');
    await fs.writeFile(target, 'x');
    const ref = describeUploadedFile(localFile('students/to-delete.png'));

    await expect(removeStoredFile(ref)).resolves.toEqual({ removed: true });
    await expect(fs.access(target)).rejects.toThrow();
  });

  test('local : un fichier déjà absent est `not_found`, pas un échec', async () => {
    const ref = describeUploadedFile(localFile('students/ghost.png'));

    await expect(removeStoredFile(ref)).resolves.toEqual({ removed: false, reason: 'not_found' });
  });

  test('local : une clé qui s’échappe d’UPLOAD_DIR est refusée', async () => {
    const ref = { provider: STORAGE_PROVIDER.LOCAL, storageKey: '../../etc/passwd' };

    await expect(removeStoredFile(ref)).resolves.toEqual({
      removed: false, reason: 'path_traversal_refused',
    });
  });

  test('cloudinary : destroy est appelé avec le public_id enregistré', async () => {
    cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

    await expect(removeStoredFile(describeUploadedFile(cloudinaryFile()))).resolves.toEqual({ removed: true });
    expect(cloudinary.uploader.destroy)
      .toHaveBeenCalledWith('backend/students/rose-9f3c2a', { invalidate: true });
  });

  test('cloudinary : « not found » et un vrai échec sont DISTINCTS', async () => {
    // C'est tout l'enjeu : `deleteFile` écrasait les deux dans un même `false`,
    // et c'est pour ça que le bug est passé inaperçu — une opération incapable
    // de distinguer ses échecs ne peut pas être supervisée.
    const ref = describeUploadedFile(cloudinaryFile());

    cloudinary.uploader.destroy.mockResolvedValue({ result: 'not found' });
    await expect(removeStoredFile(ref)).resolves.toEqual({ removed: false, reason: 'not_found' });

    cloudinary.uploader.destroy.mockRejectedValue(new Error('401 unauthorized'));
    const out = await removeStoredFile(ref);
    expect(out.removed).toBe(false);
    expect(out.reason).toMatch(/cloudinary_error:401/);
  });

  test('sans référence (ligne antérieure au champ) : `no_reference`, jamais une exception', async () => {
    await expect(removeStoredFile(null)).resolves.toEqual({ removed: false, reason: 'no_reference' });
    await expect(removeStoredFile({ provider: 'local' })).resolves.toEqual({
      removed: false, reason: 'no_reference',
    });
  });
});

describe('discardPreviousUpload — ne journalise que les vrais problèmes', () => {
  test('un fichier déjà absent ne pollue pas les logs', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await discardPreviousUpload(describeUploadedFile(localFile('students/ghost.png')), 'Student 1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('un échec réel est journalisé avec sa raison', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    cloudinary.uploader.destroy.mockRejectedValue(new Error('401 unauthorized'));

    await discardPreviousUpload(describeUploadedFile(cloudinaryFile()), 'Student 1');

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('orphaned asset'));
    spy.mockRestore();
  });
});

describe('migration des lignes antérieures — être franc sur l’irrécupérable', () => {
  const { cloudinaryKeyFromUrl, classify } = require('../../scripts/migrate-profile-image-ref');

  test('une URL Cloudinary rend sa clé : version et extension retirées', () => {
    expect(cloudinaryKeyFromUrl(
      'https://res.cloudinary.com/demo/image/upload/v1712345678/backend/students/rose-9f3c2a.png',
    )).toBe('backend/students/rose-9f3c2a');

    // Sans segment de version, et avec une query string.
    expect(cloudinaryKeyFromUrl(
      'https://res.cloudinary.com/demo/image/upload/backend/teachers/paul.jpg?x=1',
    )).toBe('backend/teachers/paul');
  });

  test('un chemin absolu local est déclaré IRRÉCUPÉRABLE, pas réparé à l’aveugle', () => {
    // Dériver une clé plausible pour un fichier qui n'existe pas sur le serveur
    // serait pire que le trou : chaque suppression rapporterait `not_found` à vie.
    expect(classify('/home/dev/Projects/university/backend/uploads/students/rose.png'))
      .toEqual({ kind: 'local_unrecoverable' });
  });

  test('une URL distante non-Cloudinary n’est pas confondue avec une clé', () => {
    expect(classify('https://example.test/avatar.png')).toEqual({ kind: 'remote_unknown' });
  });

  test('une valeur vide n’est pas comptée comme une perte', () => {
    expect(classify('').kind).toBe('empty');
    expect(classify(null).kind).toBe('empty');
  });
});
