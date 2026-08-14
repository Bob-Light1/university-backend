'use strict';

/**
 * Préflight du stockage GED (B8-①).
 *
 * `document.storage.service.js` écrit tous les fichiers de la GED sur le système
 * de fichiers local, sans branche sur NODE_ENV, tandis que `upload.js` documente —
 * dans un commentaire, dans un autre fichier — que le système de fichiers de
 * production est éphémère. Rien ne réconciliait les deux à l'exécution : un
 * déploiement dangereux démarrait sans un mot et perdait toute la GED au déploiement
 * suivant.
 *
 * Ce module ne rend PAS le stockage durable. Il fait échouer le démarrage d'un
 * déploiement qui ne l'est pas.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs').promises;

const { assertPersistentStorage, isInside, REPO_ROOT } =
  require('../../shared/utils/storage-preflight');

let exitSpy;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // process.exit doit interrompre le flux, comme en vrai.
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => jest.restoreAllMocks());

describe('isInside — le piège du préfixe de chaîne', () => {
  test.each([
    ['/app',         '/app/uploads',      true,  'enfant direct'],
    ['/app',         '/app/a/b/c',        true,  'enfant profond'],
    ['/app',         '/var/data/uploads', false, 'arbre voisin — un vrai volume'],
    ['/app',         '/app',              false, 'le répertoire lui-même n’est pas « dedans »'],
    ['/app/uploads', '/app/uploads-data', false, 'LE PIÈGE : startsWith() répondrait true'],
    ['/app',         '/app/../var/up',    false, 'sort du parent via ..'],
  ])('isInside(%s, %s) === %s — %s', (parent, target, expected) => {
    expect(isInside(parent, path.resolve(target))).toBe(expected);
  });
});

describe('assertPersistentStorage — hors production', () => {
  test('ne bloque jamais le démarrage et nomme le répertoire effectif', async () => {
    const out = await assertPersistentStorage({ NODE_ENV: 'development' });

    expect(out).toEqual({ ok: true, dir: path.join(REPO_ROOT, 'uploads'), persistent: false });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('assertPersistentStorage — production, les trois règles', () => {
  test('règle 1 : UPLOAD_DIR absent refuse le démarrage', async () => {
    await expect(assertPersistentStorage({ NODE_ENV: 'production' }))
      .rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('UPLOAD_DIR is not set'));
    // Le message doit énoncer la CONSÉQUENCE, pas seulement la condition.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DESTROYED on the next deploy'));
  });

  test('règle 2 : un chemin DANS le dépôt est un chemin conteneur déguisé', async () => {
    await expect(assertPersistentStorage({
      NODE_ENV: 'production',
      UPLOAD_DIR: path.join(REPO_ROOT, 'uploads'),
    })).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('inside the application directory'));
  });

  test('règle 3 : un répertoire inexistant (volume non monté) refuse le démarrage', async () => {
    await expect(assertPersistentStorage({
      NODE_ENV: 'production',
      UPLOAD_DIR: path.join(os.tmpdir(), `never-mounted-${process.pid}`),
    })).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not writable by this process'));
  });

  test('un volume monté, hors dépôt et inscriptible, laisse démarrer', async () => {
    const volume = path.join(os.tmpdir(), `mounted-volume-${process.pid}`);
    await fs.mkdir(volume, { recursive: true });

    const out = await assertPersistentStorage({ NODE_ENV: 'production', UPLOAD_DIR: volume });

    expect(out).toEqual({ ok: true, dir: volume, persistent: true });
    expect(exitSpy).not.toHaveBeenCalled();

    await fs.rm(volume, { recursive: true, force: true });
  });
});
