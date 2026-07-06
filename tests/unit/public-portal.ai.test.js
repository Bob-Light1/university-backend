'use strict';

/**
 * Unit tests for the public-portal AI ingestion facade (Phase 3, §6.3.1 /
 * §4.5 — D6 2nd increment: the PUBLIC portal corpus, programmes + FAQ). The
 * repository is mocked (no DB): the tests pin the ingestable-item contract, the
 * keyset pagination (limit+1 sentinel, next cursor), the isPublished/campus
 * scoping, and the answer-time citation re-authorization semantics (public
 * corpus → no per-user gating, still-published + campus cross-check only).
 */

jest.mock('../../modules/public-portal/public-portal.repository', () => ({
  findIngestablePortalSources: jest.fn(async () => []),
  findPortalCitationDocs: jest.fn(async () => []),
}));

const repo = require('../../modules/public-portal/public-portal.repository');
const service = require('../../modules/public-portal/public-portal.service');

const CAMPUS_A = 'a'.repeat(24);
const CAMPUS_B = 'b'.repeat(24);
const PROG_ID = '1'.repeat(24);
const FAQ_ID = '2'.repeat(24);
const UPDATED = new Date('2026-07-04T10:00:00.000Z');

beforeEach(() => jest.clearAllMocks());

describe('listAiIngestables — public portal feed', () => {
  test('programme → ingestable item contract (public visibility, bilingual text, epoch version)', async () => {
    repo.findIngestablePortalSources.mockResolvedValueOnce([
      {
        _id: PROG_ID, schoolCampus: CAMPUS_A, updatedAt: UPDATED, program: 'BTS SIO',
        title: { fr: 'Titre', en: 'Title' },
        content: { fr: 'Contenu FR', en: 'Content EN' },
      },
    ]);
    const { items, nextCursor } = await service.listAiIngestables({
      campusId: CAMPUS_A, type: 'portal-program', limit: 10,
    });
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      sourceType: 'portal-program',
      sourceId: PROG_ID,
      campusId: CAMPUS_A,
      version: String(UPDATED.getTime()),
      visibility: { roles: [], ownerId: null },
      title: 'Titre',
    });
    // Both languages embedded (recall in either language) + the program tag.
    expect(item.text).toContain('Program: BTS SIO');
    expect(item.text).toContain('Contenu FR');
    expect(item.text).toContain('Content EN');
  });

  test('FAQ → question as title, question + answer (fr/en) as text', async () => {
    repo.findIngestablePortalSources.mockResolvedValueOnce([
      {
        _id: FAQ_ID, schoolCampus: CAMPUS_A, updatedAt: UPDATED, category: 'pricing',
        question: { fr: 'Combien ?', en: 'How much?' },
        answer: { fr: 'Gratuit', en: 'Free' },
      },
    ]);
    const { items } = await service.listAiIngestables({
      campusId: CAMPUS_A, type: 'portal-faq', limit: 10,
    });
    expect(items[0].sourceType).toBe('portal-faq');
    expect(items[0].title).toBe('Combien ?');
    expect(items[0].text).toContain('How much?');
    expect(items[0].text).toContain('Gratuit');
  });

  test('query filters on the campus scope + isPublished:true (drafts never leak)', async () => {
    await service.listAiIngestables({ campusId: CAMPUS_A, type: 'portal-faq', limit: 10 });
    expect(repo.findIngestablePortalSources).toHaveBeenCalledWith(
      'portal-faq',
      expect.objectContaining({ schoolCampus: CAMPUS_A, isPublished: true }),
      { limit: 11 },
    );
  });

  test('limit+1 sentinel yields a nextCursor keyed on (updatedAt, _id)', async () => {
    // limit=1 → repo returns 2 rows (sentinel) → a next page exists.
    repo.findIngestablePortalSources.mockResolvedValueOnce([
      { _id: FAQ_ID, schoolCampus: CAMPUS_A, updatedAt: UPDATED, question: { fr: 'A' }, answer: { fr: 'a' } },
      { _id: PROG_ID, schoolCampus: CAMPUS_A, updatedAt: UPDATED, question: { fr: 'B' }, answer: { fr: 'b' } },
    ]);
    const { items, nextCursor } = await service.listAiIngestables({
      campusId: CAMPUS_A, type: 'portal-faq', limit: 1,
    });
    expect(items).toHaveLength(1);
    expect(nextCursor).toEqual({ updatedAt: UPDATED, id: FAQ_ID });
  });

  test('forwards the decoded keyset cursor into the repository filter', async () => {
    await service.listAiIngestables({
      campusId: CAMPUS_A, type: 'portal-program', limit: 10,
      afterUpdatedAt: UPDATED, afterId: PROG_ID,
    });
    const [, filter] = repo.findIngestablePortalSources.mock.calls[0];
    expect(filter.$or).toEqual([
      { updatedAt: { $gt: UPDATED } },
      { updatedAt: UPDATED, _id: { $gt: PROG_ID } },
    ]);
  });

  test('rejects an unsupported portal type', async () => {
    await expect(
      service.listAiIngestables({ campusId: CAMPUS_A, type: 'document', limit: 10 }),
    ).rejects.toThrow(/Unsupported portal ingestable type/);
  });
});

describe('authorizeAiCitations — public portal corpus (§4.5)', () => {
  test('scoped role: still-published + campus cross-check baked into the query, no per-user gating', async () => {
    repo.findPortalCitationDocs.mockResolvedValueOnce([
      { _id: FAQ_ID, question: { fr: 'Q?' } },
    ]);
    const allowed = await service.authorizeAiCitations(
      { role: 'STUDENT', campusId: CAMPUS_A },
      { 'portal-faq': [FAQ_ID] },
    );
    expect(repo.findPortalCitationDocs).toHaveBeenCalledWith(
      'portal-faq', [FAQ_ID], { isPublished: true, schoolCampus: CAMPUS_A },
    );
    expect(allowed).toEqual([
      { sourceType: 'portal-faq', sourceId: FAQ_ID, label: 'Q?', url: '' },
    ]);
  });

  test('global role (ADMIN): campus filter dropped (any campus), published check kept', async () => {
    repo.findPortalCitationDocs.mockResolvedValueOnce([
      { _id: PROG_ID, title: { fr: 'Prog' }, program: 'BTS' },
    ]);
    await service.authorizeAiCitations(
      { role: 'ADMIN', campusId: CAMPUS_B },
      { 'portal-program': [PROG_ID] },
    );
    expect(repo.findPortalCitationDocs).toHaveBeenCalledWith(
      'portal-program', [PROG_ID], { isPublished: true },
    );
  });

  test('ignores unknown source types and empty id lists', async () => {
    const allowed = await service.authorizeAiCitations(
      { role: 'STUDENT', campusId: CAMPUS_A },
      { document: [PROG_ID], 'portal-faq': [] },
    );
    expect(repo.findPortalCitationDocs).not.toHaveBeenCalled();
    expect(allowed).toEqual([]);
  });
});
