'use strict';

/**
 * Couche repository — module document (R3, cœur académique ; 5 models).
 * Models mockés (sans DB) : Document, DocumentVersion, DocumentAudit,
 * DocumentTemplate, DocumentShare — tous des exports PAR DÉFAUT (constructeurs).
 *
 * Le mock de query est chaînable ET thenable : chaque méthode de query
 * (select/sort/skip/limit/populate/session/lean) renvoie la query, et l'attente
 * (`await`) résout `__lean`. C'est nécessaire car le repo enchaîne parfois
 * `.lean().session()` (garde de débounce des snapshots) — l'ordre des maillons
 * ne doit donc pas terminer la chaîne.
 *
 * Accent : formes de requête (select/populate/sort), propagation de session sur
 * les écritures transactionnelles, atomiques ($inc download/usage, $push IP) et
 * non-régression de l'agrégat de quota stockage (pipeline $match casté/$group).
 */

const buildModelMock = () => {
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.__lean = null;
  Model.__setLean = (v) => { Model.__lean = v; };

  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate', 'session', 'lean'].forEach((m) => {
      q[m] = jest.fn(() => q);
    });
    q.exec = jest.fn(() => Promise.resolve(Model.__lean));
    q.then = (resolve, reject) => Promise.resolve(Model.__lean).then(resolve, reject);
    return q;
  };

  ['find', 'findOne', 'findById'].forEach((m) => { Model[m] = jest.fn(() => makeQuery()); });
  Model.countDocuments      = jest.fn(() => makeQuery());
  Model.aggregate           = jest.fn(() => Promise.resolve([]));
  Model.create              = jest.fn((d) => Promise.resolve(Array.isArray(d) ? d.map((x, i) => ({ _id: `c${i}`, ...x })) : { _id: 'c', ...d }));
  Model.insertMany          = jest.fn((docs) => Promise.resolve(docs));
  Model.deleteMany          = jest.fn(() => Promise.resolve({ deletedCount: 0 }));
  Model.findByIdAndUpdate   = jest.fn(() => Promise.resolve({ _id: 'updated' }));
  Model.findOneAndUpdate    = jest.fn(() => Promise.resolve({ _id: 'updated' }));
  Model.findByIdAndDelete   = jest.fn(() => Promise.resolve({ _id: 'deleted' }));
  Model.__makeQuery = makeQuery;
  return Model;
};

jest.mock('mongoose', () => ({ startSession: jest.fn(() => Promise.resolve('SESSION')) }));
jest.mock('../../modules/document/models/document.model',          () => buildModelMock());
jest.mock('../../modules/document/models/document.version.model',  () => buildModelMock());
jest.mock('../../modules/document/models/document.audit.model',    () => buildModelMock());
jest.mock('../../modules/document/models/document.template.model', () => buildModelMock());
jest.mock('../../modules/document/models/document.share.model',    () => buildModelMock());

const mongoose         = require('mongoose');
const Document         = require('../../modules/document/models/document.model');
const DocumentVersion  = require('../../modules/document/models/document.version.model');
const DocumentAudit    = require('../../modules/document/models/document.audit.model');
const DocumentTemplate = require('../../modules/document/models/document.template.model');
const DocumentShare    = require('../../modules/document/models/document.share.model');
const repo = require('../../modules/document/document.repository');

const ALL = [Document, DocumentVersion, DocumentAudit, DocumentTemplate, DocumentShare];

beforeEach(() => {
  jest.clearAllMocks();
  ALL.forEach((M) => M.__setLean(null));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document — transactions', () => {
  test('startSession : délègue à mongoose.startSession', async () => {
    const s = await repo.startSession();
    expect(mongoose.startSession).toHaveBeenCalled();
    expect(s).toBe('SESSION');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document — création', () => {
  test('createDocuments : Document.create(docs, opts) — forme tableau + session', () => {
    repo.createDocuments([{ title: 'x' }], { session: 'S' });
    expect(Document.create).toHaveBeenCalledWith([{ title: 'x' }], { session: 'S' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document — lectures', () => {
  test('paginateDocuments : find+sort+skip+limit+select(-body -rawHtml)+lean, count → {data,total}', async () => {
    Document.__setLean([{ _id: 'd1' }]);
    Document.countDocuments.mockReturnValueOnce(Promise.resolve(7));
    const q = Document.__makeQuery();
    Document.find.mockReturnValueOnce(q);
    const out = await repo.paginateDocuments({ deletedAt: null }, { skip: 10, limit: 20, sort: { createdAt: -1 } });
    expect(Document.find).toHaveBeenCalledWith({ deletedAt: null });
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.skip).toHaveBeenCalledWith(10);
    expect(q.limit).toHaveBeenCalledWith(20);
    expect(q.select).toHaveBeenCalledWith('-body -rawHtml');
    expect(q.lean).toHaveBeenCalled();
    expect(out).toEqual({ data: [{ _id: 'd1' }], total: 7 });
  });

  test('searchDocuments : find(filter, projection)+select(-body -rawHtml), count → {data,total}', async () => {
    Document.__setLean([{ _id: 'd2' }]);
    Document.countDocuments.mockReturnValueOnce(Promise.resolve(2));
    const q = Document.__makeQuery();
    Document.find.mockReturnValueOnce(q);
    const projection = { score: { $meta: 'textScore' } };
    const out = await repo.searchDocuments({ $text: { $search: 'x' } }, { skip: 0, limit: 20, sort: projection, projection });
    expect(Document.find).toHaveBeenCalledWith({ $text: { $search: 'x' } }, projection);
    expect(q.sort).toHaveBeenCalledWith(projection);
    expect(q.select).toHaveBeenCalledWith('-body -rawHtml');
    expect(out).toEqual({ data: [{ _id: 'd2' }], total: 2 });
  });

  test('findDocumentByIdPopulated : findOne(filter)+populate(templateId)+lean', () => {
    const q = Document.__makeQuery();
    Document.findOne.mockReturnValueOnce(q);
    repo.findDocumentByIdPopulated({ _id: 'd1', deletedAt: null });
    expect(Document.findOne).toHaveBeenCalledWith({ _id: 'd1', deletedAt: null });
    expect(q.populate).toHaveBeenCalledWith('templateId', 'name type');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentLean : findOne(filter)+select(optionnel)+lean', () => {
    const q = Document.__makeQuery();
    Document.findOne.mockReturnValueOnce(q);
    repo.findDocumentLean({ _id: 'd1' }, '_id campusId status isOfficial');
    expect(Document.findOne).toHaveBeenCalledWith({ _id: 'd1' });
    expect(q.select).toHaveBeenCalledWith('_id campusId status isOfficial');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentLean : sans select → pas de .select()', () => {
    const q = Document.__makeQuery();
    Document.findOne.mockReturnValueOnce(q);
    repo.findDocumentLean({ _id: 'd1' });
    expect(q.select).not.toHaveBeenCalled();
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentByIdLean : findById(id)+select(select)+lean', () => {
    const q = Document.__makeQuery();
    Document.findById.mockReturnValueOnce(q);
    repo.findDocumentByIdLean('d1', 'campusId type status');
    expect(Document.findById).toHaveBeenCalledWith('d1');
    expect(q.select).toHaveBeenCalledWith('campusId type status');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentsByFilterLean : find(filter)+select+lean', () => {
    const q = Document.__makeQuery();
    Document.find.mockReturnValueOnce(q);
    repo.findDocumentsByFilterLean({ _id: { $in: ['a'] } }, '_id ref title');
    expect(Document.find).toHaveBeenCalledWith({ _id: { $in: ['a'] } });
    expect(q.select).toHaveBeenCalledWith('_id ref title');
    expect(q.lean).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document — écritures', () => {
  test('findDocumentForWrite : findOne(filter).session(session) (NON lean)', () => {
    const q = Document.__makeQuery();
    Document.findOne.mockReturnValueOnce(q);
    repo.findDocumentForWrite({ _id: 'd1' }, { session: 'S' });
    expect(Document.findOne).toHaveBeenCalledWith({ _id: 'd1' });
    expect(q.session).toHaveBeenCalledWith('S');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('findDocumentForWrite : sans session → .session(null)', () => {
    const q = Document.__makeQuery();
    Document.findOne.mockReturnValueOnce(q);
    repo.findDocumentForWrite({ _id: 'd1' });
    expect(q.session).toHaveBeenCalledWith(null);
  });

  test('findDocumentByIdForWrite : findById(id).session(session)', () => {
    const q = Document.__makeQuery();
    Document.findById.mockReturnValueOnce(q);
    repo.findDocumentByIdForWrite('d1', { session: 'S' });
    expect(Document.findById).toHaveBeenCalledWith('d1');
    expect(q.session).toHaveBeenCalledWith('S');
  });

  test('saveDocumentDoc : délègue à doc.save(opts)', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveDocumentDoc({ save }, { session: 'S' });
    expect(save).toHaveBeenCalledWith({ session: 'S' });
  });

  test('updateDocumentById : findByIdAndUpdate(id, update, opts)', () => {
    repo.updateDocumentById('d1', { $set: { title: 'y' } }, { new: true, session: 'S' });
    expect(Document.findByIdAndUpdate).toHaveBeenCalledWith('d1', { $set: { title: 'y' } }, { new: true, session: 'S' });
  });

  test('incrementDownloadCount : $inc downloadCount atomique', () => {
    repo.incrementDownloadCount('d1');
    expect(Document.findByIdAndUpdate).toHaveBeenCalledWith('d1', { $inc: { downloadCount: 1 } });
  });

  test('setPdfSnapshot : écrit pdfSnapshot', () => {
    repo.setPdfSnapshot('d1', 'REF_v1_x.pdf');
    expect(Document.findByIdAndUpdate).toHaveBeenCalledWith('d1', { pdfSnapshot: 'REF_v1_x.pdf' });
  });

  test('deleteDocumentById : findByIdAndDelete(id, opts)', () => {
    repo.deleteDocumentById('d1', { session: 'S' });
    expect(Document.findByIdAndDelete).toHaveBeenCalledWith('d1', { session: 'S' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document — lectures spécialisées (façade / cron / pdf / quota)', () => {
  test('paginatePublishedForCampus : select(-__v -auditLog -versions)+sort createdAt desc → {docs,total}', async () => {
    Document.__setLean([{ _id: 'p1' }]);
    Document.countDocuments.mockReturnValueOnce(Promise.resolve(4));
    const q = Document.__makeQuery();
    Document.find.mockReturnValueOnce(q);
    const out = await repo.paginatePublishedForCampus({ campusId: 'c', status: 'PUBLISHED' }, { skip: 0, limit: 20 });
    expect(q.select).toHaveBeenCalledWith('-__v -auditLog -versions');
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(out).toEqual({ docs: [{ _id: 'p1' }], total: 4 });
  });

  test('findExpiredDocuments : select rétention+skip+limit+lean', () => {
    const q = Document.__makeQuery();
    Document.find.mockReturnValueOnce(q);
    repo.findExpiredDocuments({ deletedAt: null }, { skip: 0, limit: 100 });
    expect(q.select).toHaveBeenCalledWith('_id campusId ref retentionPolicy retentionUntil');
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(100);
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentForPdf : select corps+branding+printConfig+lean', () => {
    const q = Document.__makeQuery();
    Document.findById.mockReturnValueOnce(q);
    repo.findDocumentForPdf('d1');
    expect(q.select).toHaveBeenCalledWith('ref title body branding printConfig campusId currentVersion pdfSnapshot');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findDocumentForPdfCache : select minimal cache+lean', () => {
    const q = Document.__makeQuery();
    Document.findById.mockReturnValueOnce(q);
    repo.findDocumentForPdfCache('d1');
    expect(q.select).toHaveBeenCalledWith('ref pdfSnapshot currentVersion campusId');
    expect(q.lean).toHaveBeenCalled();
  });

  test('aggregateImportedStorageBytes : pipeline $match (fourni casté) + $group $sum sizeBytes', async () => {
    Document.aggregate.mockReturnValueOnce(Promise.resolve([{ _id: null, totalBytes: 2048 }]));
    const match = { campusId: 'CASTED', deletedAt: null, 'importedFile.sizeBytes': { $exists: true, $ne: null } };
    const out = await repo.aggregateImportedStorageBytes(match);
    expect(Document.aggregate).toHaveBeenCalledWith([
      { $match: match },
      { $group: { _id: null, totalBytes: { $sum: '$importedFile.sizeBytes' } } },
    ]);
    expect(out).toEqual([{ _id: null, totalBytes: 2048 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document version', () => {
  test('findRecentAutoSnapshot : findOne+select(_id takenAt)+lean+session (chaîne lean→session)', async () => {
    DocumentVersion.__setLean({ _id: 'v1', takenAt: new Date(0) });
    const q = DocumentVersion.__makeQuery();
    DocumentVersion.findOne.mockReturnValueOnce(q);
    const filter = { documentId: 'd1', snapshotReason: 'auto' };
    const out = await repo.findRecentAutoSnapshot(filter, { session: 'S' });
    expect(DocumentVersion.findOne).toHaveBeenCalledWith(filter);
    expect(q.select).toHaveBeenCalledWith('_id takenAt');
    expect(q.lean).toHaveBeenCalled();
    expect(q.session).toHaveBeenCalledWith('S');
    expect(out).toEqual({ _id: 'v1', takenAt: new Date(0) });
  });

  test('createVersions : DocumentVersion.create(docs, opts)', () => {
    repo.createVersions([{ version: 2 }], { session: 'S' });
    expect(DocumentVersion.create).toHaveBeenCalledWith([{ version: 2 }], { session: 'S' });
  });

  test('paginateVersions : sort version desc+select(-body)+lean → {data,total}', async () => {
    DocumentVersion.__setLean([{ version: 3 }]);
    DocumentVersion.countDocuments.mockReturnValueOnce(Promise.resolve(3));
    const q = DocumentVersion.__makeQuery();
    DocumentVersion.find.mockReturnValueOnce(q);
    const out = await repo.paginateVersions({ documentId: 'd1' }, { skip: 0, limit: 50 });
    expect(q.sort).toHaveBeenCalledWith({ version: -1 });
    expect(q.select).toHaveBeenCalledWith('-body');
    expect(out).toEqual({ data: [{ version: 3 }], total: 3 });
  });

  test('findVersionLean : findOne(filter)+lean', () => {
    const q = DocumentVersion.__makeQuery();
    DocumentVersion.findOne.mockReturnValueOnce(q);
    repo.findVersionLean({ documentId: 'd1', version: 2 });
    expect(DocumentVersion.findOne).toHaveBeenCalledWith({ documentId: 'd1', version: 2 });
    expect(q.lean).toHaveBeenCalled();
  });

  test('deleteVersionsByDocument : deleteMany({documentId}, opts)', () => {
    repo.deleteVersionsByDocument('d1', { session: 'S' });
    expect(DocumentVersion.deleteMany).toHaveBeenCalledWith({ documentId: 'd1' }, { session: 'S' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document audit (append-only)', () => {
  test('createAudit : create(docs, opts) quand opts fourni (transaction)', () => {
    repo.createAudit([{ action: 'CREATE' }], { session: 'S' });
    expect(DocumentAudit.create).toHaveBeenCalledWith([{ action: 'CREATE' }], { session: 'S' });
  });

  test('createAudit : create(docs) sans opts (cron, objet simple)', () => {
    repo.createAudit({ action: 'DELETE' });
    expect(DocumentAudit.create).toHaveBeenCalledWith({ action: 'DELETE' });
    expect(DocumentAudit.create.mock.calls[0]).toHaveLength(1);
  });

  test('paginateAudits : sort performedAt desc+lean → {data,total}', async () => {
    DocumentAudit.__setLean([{ action: 'PUBLISH' }]);
    DocumentAudit.countDocuments.mockReturnValueOnce(Promise.resolve(1));
    const q = DocumentAudit.__makeQuery();
    DocumentAudit.find.mockReturnValueOnce(q);
    const out = await repo.paginateAudits({ documentId: 'd1' }, { skip: 0, limit: 20 });
    expect(q.sort).toHaveBeenCalledWith({ performedAt: -1 });
    expect(out).toEqual({ data: [{ action: 'PUBLISH' }], total: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document template', () => {
  test('createTemplate : DocumentTemplate.create(payload)', () => {
    repo.createTemplate({ name: 't' });
    expect(DocumentTemplate.create).toHaveBeenCalledWith({ name: 't' });
  });

  test('listTemplates : sort usageCount desc puis createdAt desc + lean', () => {
    const q = DocumentTemplate.__makeQuery();
    DocumentTemplate.find.mockReturnValueOnce(q);
    repo.listTemplates({ isActive: true });
    expect(DocumentTemplate.find).toHaveBeenCalledWith({ isActive: true });
    expect(q.sort).toHaveBeenCalledWith({ usageCount: -1, createdAt: -1 });
    expect(q.lean).toHaveBeenCalled();
  });

  test('findTemplateByIdLean : findById+lean', () => {
    const q = DocumentTemplate.__makeQuery();
    DocumentTemplate.findById.mockReturnValueOnce(q);
    repo.findTemplateByIdLean('t1');
    expect(DocumentTemplate.findById).toHaveBeenCalledWith('t1');
    expect(q.lean).toHaveBeenCalled();
  });

  test('findTemplateForWrite : findById SANS lean (doc à muter)', () => {
    const q = DocumentTemplate.__makeQuery();
    DocumentTemplate.findById.mockReturnValueOnce(q);
    repo.findTemplateForWrite('t1');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('saveTemplateDoc : délègue à doc.save()', () => {
    const save = jest.fn(() => Promise.resolve());
    repo.saveTemplateDoc({ save });
    expect(save).toHaveBeenCalled();
  });

  test('incrementTemplateUsage : $inc usageCount atomique', () => {
    repo.incrementTemplateUsage('t1');
    expect(DocumentTemplate.findByIdAndUpdate).toHaveBeenCalledWith('t1', { $inc: { usageCount: 1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('document share (liens signés)', () => {
  test('createShare : DocumentShare.create(payload)', () => {
    repo.createShare({ tokenHash: 'h' });
    expect(DocumentShare.create).toHaveBeenCalledWith({ tokenHash: 'h' });
  });

  test('findShareByTokenHashPopulated : findOne{tokenHash,revoked:false}+populate(documentId)+lean', () => {
    const q = DocumentShare.__makeQuery();
    DocumentShare.findOne.mockReturnValueOnce(q);
    repo.findShareByTokenHashPopulated('hash');
    expect(DocumentShare.findOne).toHaveBeenCalledWith({ tokenHash: 'hash', revoked: false });
    expect(q.populate).toHaveBeenCalledWith('documentId', 'title ref campusId status isOfficial pdfSnapshot currentVersion');
    expect(q.lean).toHaveBeenCalled();
  });

  test('registerShareAccess : $inc downloadCount + $push accessedIps (atomique)', () => {
    repo.registerShareAccess('s1', '1.2.3.4');
    expect(DocumentShare.findByIdAndUpdate).toHaveBeenCalledWith('s1', {
      $inc:  { downloadCount: 1 },
      $push: { accessedIps: '1.2.3.4' },
    });
  });

  test('revokeShare : findOneAndUpdate(filter, payload, {new:true})', () => {
    const payload = { revoked: true, revokedAt: new Date(0), revokedBy: 'u1' };
    repo.revokeShare({ _id: 's1', revoked: false }, payload);
    expect(DocumentShare.findOneAndUpdate).toHaveBeenCalledWith({ _id: 's1', revoked: false }, payload, { new: true });
  });

  test('listShares : select(-tokenHash)+sort createdAt desc+lean (hash jamais exposé)', () => {
    const q = DocumentShare.__makeQuery();
    DocumentShare.find.mockReturnValueOnce(q);
    repo.listShares({ documentId: 'd1', revoked: false });
    expect(q.select).toHaveBeenCalledWith('-tokenHash');
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.lean).toHaveBeenCalled();
  });
});
