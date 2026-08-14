'use strict';

/**
 * Backend object store de la GED (B8-①).
 *
 * Ce fichier épingle les PARAMÈTRES envoyés à Cloudinary, contre un SDK doublé.
 * Il ne peut pas prouver l'aller-retour réel — cela demande un compte, et le bac à
 * sable n'a pas d'accès réseau sortant. Ce qu'il prouve est ce qui casse en silence :
 *
 *   - `resource_type: 'raw'` pour TOUT, images comprises. Cloudinary retire une
 *     extension d'image reconnue du `public_id` d'un asset `image` : un delete qui
 *     recalcule l'identifiant depuis (campus, catégorie, fichier) n'adresserait alors
 *     plus rien et rapporterait un succès. C'est ce qui permet à Mongo de continuer à
 *     stocker un simple nom de fichier, sans migration de schéma.
 *   - `type: 'authenticated'` pour TOUT. La règle centrale de la GED est que les
 *     fichiers ne sont JAMAIS servis en statique. Un asset `upload` par défaut est
 *     public pour quiconque détient son URL — ce qui déplacerait tout le contrôle
 *     d'accès de « l'API décide » vers « l'URL est difficile à deviner », pour des
 *     relevés de notes et des pièces d'identité.
 *   - l'identité utilisée pour ÉCRIRE et celle utilisée pour SUPPRIMER sont la même.
 */

const mockUploadStream = jest.fn();
const mockDestroy      = jest.fn();
const mockResource     = jest.fn();
const mockPrivateUrl   = jest.fn(() => 'https://res.cloudinary.test/signed');
const mockConfig       = jest.fn();

// Les identifiants doivent être posés AVANT le require du backend : il se configure
// à la charge, et c'est précisément ce qui est épinglé plus bas.
process.env.CLOUDINARY_CLOUD_NAME = 'forun-test';
process.env.CLOUDINARY_API_KEY    = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';

jest.mock('cloudinary', () => ({
  v2: {
    config:   (...args) => mockConfig(...args),
    uploader: {
      upload_stream: (...args) => mockUploadStream(...args),
      destroy:       (...args) => mockDestroy(...args),
    },
    api:   { resource: (...args) => mockResource(...args) },
    utils: { private_download_url: (...args) => mockPrivateUrl(...args) },
  },
}));

const backend = require('../../modules/document/services/document.storage.cloudinary');

// Capté À LA CHARGE : la configuration a lieu au require, et `jest.clearAllMocks()`
// dans le beforeEach effacerait la trace avant que le test ne puisse la lire.
const CONFIG_AT_LOAD = mockConfig.mock.calls.map(([options]) => options);

const CAMPUS = '507f1f77bcf86cd799439011';

/** Doublure de `upload_stream` : capte les options et rend `result` au callback. */
const stubUpload = (result = { bytes: 42 }, error = null) => {
  mockUploadStream.mockImplementation((options, callback) => {
    const sink = {
      on:  () => sink,
      end: () => setImmediate(() => callback(error, result)),
    };
    // Exposé pour les assertions sur les options réellement envoyées.
    stubUpload.lastOptions = options;
    return sink;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  stubUpload();
});

describe('le SDK est configuré ICI, pas hérité', () => {
  test('le backend appelle cloudinary.config() à sa propre charge', () => {
    // Trouvé par `scripts/smoke-cloudinary.js` au premier essai réel : ce fichier
    // faisait require('cloudinary') sans jamais le configurer, et empruntait en
    // silence la configuration posée par shared/middleware/upload.js. Dans le serveur
    // ça tient par accident (app.js charge les routes, qui chargent upload.js). Hors
    // serveur — script de migration, worker, ce test — rien ne configure le SDK et
    // TOUT téléversement échoue avec « Must supply api_key ».
    expect(CONFIG_AT_LOAD).toContainEqual({
      cloud_name: 'forun-test',
      api_key:    'test-key',
      api_secret: 'test-secret',
    });
  });
});

describe('publicIdFor — déterministe et inversible', () => {
  test('préfixe le dossier racine et garde l’extension', () => {
    // Avec resource_type 'raw' l'extension fait partie de l'identifiant : la
    // construction est une concaténation pure, sans inférence de format.
    expect(backend.publicIdFor(`${CAMPUS}/imported/abc-123.pdf`))
      .toBe(`ged/${CAMPUS}/imported/abc-123.pdf`);
    expect(backend.publicIdFor(`${CAMPUS}/images/photo.png`))
      .toBe(`ged/${CAMPUS}/images/photo.png`);
  });
});

describe('put — les options qui rendent le delete adressable', () => {
  test('envoie resource_type raw, type authenticated, et le public_id complet', async () => {
    await backend.put(`${CAMPUS}/images/photo.png`, Buffer.from('bytes'));

    expect(stubUpload.lastOptions).toMatchObject({
      resource_type: 'raw',
      type:          'authenticated',
      public_id:     `ged/${CAMPUS}/images/photo.png`,
      overwrite:     true,
      invalidate:    true,
    });
  });

  test('une image n’est PAS envoyée comme resource_type image', async () => {
    // Le piège : Cloudinary retirerait `.png` du public_id, et deleteFile n'aurait
    // plus rien à supprimer — en rapportant un succès.
    await backend.put(`${CAMPUS}/images/photo.png`, Buffer.from('bytes'));

    expect(stubUpload.lastOptions.resource_type).not.toBe('image');
  });

  test('rend la taille rapportée par le store', async () => {
    stubUpload({ bytes: 1234 });

    const out = await backend.put(`${CAMPUS}/pdf/a.pdf`, Buffer.from('x'));

    expect(out).toEqual({ key: `${CAMPUS}/pdf/a.pdf`, sizeBytes: 1234 });
  });

  test('retombe sur la taille du tampon si le store n’en rapporte pas', async () => {
    stubUpload({});

    const out = await backend.put(`${CAMPUS}/pdf/a.pdf`, Buffer.from('12345'));

    expect(out.sizeBytes).toBe(5);
  });

  test('propage une erreur d’upload au lieu de la ravaler', async () => {
    stubUpload(null, new Error('quota exceeded'));

    await expect(backend.put(`${CAMPUS}/pdf/a.pdf`, Buffer.from('x')))
      .rejects.toThrow('quota exceeded');
  });
});

describe('remove — adresse exactement ce que put a écrit', () => {
  test('même resource_type et même type que l’écriture', async () => {
    mockDestroy.mockResolvedValue({ result: 'ok' });

    await backend.put(`${CAMPUS}/imported/f.pdf`, Buffer.from('x'));
    const written = stubUpload.lastOptions.public_id;

    expect(await backend.remove(`${CAMPUS}/imported/f.pdf`)).toBe(true);

    const [publicId, options] = mockDestroy.mock.calls[0];
    expect(publicId).toBe(written);          // la même identité, des deux côtés
    expect(options).toMatchObject({ resource_type: 'raw', type: 'authenticated' });
  });

  test('un objet déjà absent rend false, pas une exception', async () => {
    mockDestroy.mockResolvedValue({ result: 'not found' });

    expect(await backend.remove(`${CAMPUS}/imported/gone.pdf`)).toBe(false);
  });

  test('une panne du store rend false — un fichier résiduel n’annule pas une suppression validée', async () => {
    mockDestroy.mockRejectedValue(new Error('network down'));

    expect(await backend.remove(`${CAMPUS}/imported/f.pdf`)).toBe(false);
  });
});

describe('lectures — signées, jamais publiques', () => {
  test('l’URL de lecture est signée et expirante', () => {
    backend.signedUrl(`${CAMPUS}/pdf/a.pdf`);

    const [publicId, format, options] = mockPrivateUrl.mock.calls[0];
    expect(publicId).toBe(`ged/${CAMPUS}/pdf/a.pdf`);
    expect(format).toBe('');                       // déjà porté par le public_id (raw)
    expect(options).toMatchObject({ resource_type: 'raw', type: 'authenticated' });
    expect(options.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('get rend le tampon sur 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    });

    expect(await backend.get(`${CAMPUS}/pdf/a.pdf`)).toEqual(Buffer.from('hello'));
  });

  test('get rend null sur une réponse non-OK au lieu d’un tampon vide', async () => {
    // Un tampon vide se lirait comme un PDF de 0 octet — donc comme un fichier
    // valide et corrompu, plutôt que comme un fichier absent.
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

    expect(await backend.get(`${CAMPUS}/pdf/a.pdf`)).toBeNull();
  });

  test('openStream rend null quand il n’y a pas de corps', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });

    expect(await backend.openStream(`${CAMPUS}/pdf/a.pdf`)).toBeNull();
  });

  test('head rend null quand la ressource n’existe pas', async () => {
    mockResource.mockRejectedValue(Object.assign(new Error('Not Found'), { http_code: 404 }));

    expect(await backend.head(`${CAMPUS}/pdf/a.pdf`)).toBeNull();
  });

  test('head rend la taille déclarée par le store', async () => {
    mockResource.mockResolvedValue({ bytes: 9001 });

    expect(await backend.head(`${CAMPUS}/pdf/a.pdf`)).toEqual({ sizeBytes: 9001 });
  });
});
