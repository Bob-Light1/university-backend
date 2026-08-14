'use strict';

/**
 * Cron — document retention enforcement (B9-③).
 *
 * The repository and the academic-print facade are mocked (no DB). The fake
 * repository reproduces the one property that made the original bug invisible:
 * the candidate set is SELF-DRAINING — soft-deleting a document removes it from
 * the very filter the job re-queries.
 *
 * The decisive assertion in every test below is on the OUTSTANDING set, never on
 * `processed`. The broken job reported `Processed: 150, Errors: 0` while leaving
 * 100 documents expired; a job can only report what it did, so asserting on its
 * own counter is how this survived four tracks unnoticed.
 */

jest.mock('../../modules/document/document.repository');
jest.mock('../../modules/academic-print', () => ({
  service: { cleanupExpiredPrintFiles: jest.fn().mockResolvedValue(0) },
}));

const repo = require('../../modules/document/document.repository');
const { runRetentionJob } = require('../../modules/document/document.retention.cron');

/**
 * In-memory stand-in for document.repository with the real draining semantics.
 *
 * @param {number} count             number of expired documents to seed
 * @param {object} [opts]
 * @param {Set}    [opts.failIds]    ids whose soft-delete write throws
 * @param {number} [opts.hardLimit]  safety net: throw if the job over-fetches
 */
function seedRepo(count, { failIds = new Set(), hardLimit = 200 } = {}) {
  const docs = Array.from({ length: count }, (_, i) => ({
    _id:            `doc-${i}`,
    campusId:       'campus-1',
    ref:            `DOC-${i}`,
    retentionPolicy: '1Y',
    retentionUntil:  new Date('2020-01-01'),
    deletedAt:       null,
  }));
  const audits = [];
  let fetches = 0;

  const outstanding = () => docs.filter((d) => d.deletedAt === null);

  repo.findExpiredDocuments.mockImplementation(async (_filter, options) => {
    // The offset must not merely be unused — it must be unrepresentable.
    expect(options).not.toHaveProperty('skip');
    if (++fetches > hardLimit) throw new Error('runaway loop: too many fetches');
    return outstanding().slice(0, options.limit);
  });
  repo.countExpiredDocuments.mockImplementation(async () => outstanding().length);
  repo.createAudit.mockImplementation(async (entry) => { audits.push(entry); });
  repo.updateDocumentById.mockImplementation(async (id, patch) => {
    if (failIds.has(id)) throw new Error(`write failed for ${id}`);
    Object.assign(docs.find((d) => d._id === id), patch);
  });

  return { docs, audits, outstanding, fetches: () => fetches };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('runRetentionJob — le backlog se draine entièrement (B9-③)', () => {
  test('250 documents expirés, batch de 100 → il n’en reste ZÉRO', async () => {
    const state = seedRepo(250);

    const out = await runRetentionJob();

    // L'assertion qui compte : l'ensemble restant, pas le compteur du job.
    expect(state.outstanding()).toHaveLength(0);
    expect(out.remaining).toBe(0);
    expect(out.errors).toBe(0);
    expect(out.processed).toBe(250);
    expect(state.audits).toHaveLength(250); // une entrée de journal par suppression
  });

  test.each([80, 100, 101, 250, 1000])(
    'un backlog de %i documents ne laisse aucun reliquat',
    async (n) => {
      const state = seedRepo(n, { hardLimit: 50 });

      const out = await runRetentionJob();

      expect(state.outstanding()).toHaveLength(0);
      expect(out.remaining).toBe(0);
    },
  );

  test('la boucle historique à offset laissait 100 des 250 en place (baseline du bug)', () => {
    // Reproduction du code retiré, pour que la régression ait un point de comparaison.
    const BATCH = 100;
    const docs = Array.from({ length: 250 }, (_, i) => ({ id: i, deleted: false }));
    let skip = 0;
    let processed = 0;
    let hasMore = true;

    while (hasMore) {
      const page = docs.filter((d) => !d.deleted).slice(skip, skip + BATCH);
      if (page.length === 0) break;
      page.forEach((d) => { d.deleted = true; processed++; });
      skip += page.length;
      hasMore = page.length === BATCH;
    }

    expect(processed).toBe(150);
    expect(docs.filter((d) => !d.deleted)).toHaveLength(100);
  });
});

describe('runRetentionJob — terminaison et signalement', () => {
  test('un ensemble vide coûte une requête, ne boucle pas et n’est pas une erreur', async () => {
    const state = seedRepo(0);

    const out = await runRetentionJob();

    expect(state.fetches()).toBe(1);
    expect(out).toMatchObject({ processed: 0, errors: 0, remaining: 0 });
  });

  test('un document en échec est réessayé dans le run, les autres se drainent quand même', async () => {
    const state = seedRepo(150, { failIds: new Set(['doc-7']) });

    const out = await runRetentionJob();

    expect(out.processed).toBe(149);
    expect(out.remaining).toBe(1);         // le document en échec est encore expiré — correct
    expect(state.outstanding()).toEqual([expect.objectContaining({ _id: 'doc-7' })]);
    expect(out.errors).toBe(2);            // tenté au batch 1, re-lu et retenté au batch 2
  });

  test('un batch entièrement en échec s’arrête au lieu de boucler à l’infini', async () => {
    const all = new Set(Array.from({ length: 300 }, (_, i) => `doc-${i}`));
    const state = seedRepo(300, { failIds: all, hardLimit: 5 });

    const out = await runRetentionJob();

    expect(state.fetches()).toBe(1);       // aucun second batch identique
    expect(out.errors).toBe(100);
    expect(out.remaining).toBe(300);       // et le job le DIT, au lieu de rapporter un succès
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not draining'));
  });

  test('un batch court entièrement en échec ne se rapporte pas comme drainé', async () => {
    const state = seedRepo(5, { failIds: new Set(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']) });

    const out = await runRetentionJob();

    expect(out.remaining).toBe(5);
    expect(state.outstanding()).toHaveLength(5);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not draining'));
  });
});
