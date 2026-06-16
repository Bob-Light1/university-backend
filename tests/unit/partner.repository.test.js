'use strict';

/**
 * Couche repository — module partner (R2, dernier ; 4 models). Models mockés
 * (sans DB) : Partner, PartnerLead, PartnerCommission, PartnerApplication.
 *
 * jest.mock impose des chemins littéraux + une factory auto-suffisante (hoisting).
 * Chaque model est un constructeur (pour `new X().save()`) doté de statiques
 * jest.fn. Les queries sont chaînables (select/sort/skip/limit/populate) ; .lean
 * et .exec résolvent une valeur configurable via __setLean.
 */

const buildModelMock = () => {
  let leanVal = null;
  let deleteVal = { _id: 'd' };
  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.exec = jest.fn(() => Promise.resolve(leanVal));
    q.then = (resolve) => Promise.resolve(leanVal).then(resolve);
    return q;
  };
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.prototype.save = jest.fn(function save() { return Promise.resolve(this); });
  ['find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate'].forEach((m) => {
    Model[m] = jest.fn(() => makeQuery());
  });
  Model.findOneAndDelete = jest.fn(() => Promise.resolve(deleteVal));
  Model.countDocuments = jest.fn(() => Promise.resolve(7));
  Model.aggregate = jest.fn(() => Promise.resolve([]));
  Model.create = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  Model.generatePartnerCode = jest.fn(() => Promise.resolve('NDOJO-CMR-2026-AB12'));
  Model.__setLean = (v) => { leanVal = v; };
  Model.__setDelete = (v) => { deleteVal = v; };
  return Model;
};

jest.mock('../../modules/partner/models/partner.model', () => buildModelMock());
jest.mock('../../modules/partner/models/partner.lead.model', () => buildModelMock());
jest.mock('../../modules/partner/models/partner.commission.model', () => buildModelMock());
jest.mock('../../modules/partner/models/partner.application.model', () => buildModelMock());

const Partner            = require('../../modules/partner/models/partner.model');
const PartnerLead        = require('../../modules/partner/models/partner.lead.model');
const PartnerCommission  = require('../../modules/partner/models/partner.commission.model');
const PartnerApplication = require('../../modules/partner/models/partner.application.model');
const repo = require('../../modules/partner/partner.repository');

beforeEach(() => {
  jest.clearAllMocks();
  [Partner, PartnerLead, PartnerCommission, PartnerApplication].forEach((M) => {
    M.__setLean(null);
    M.__setDelete({ _id: 'd' });
  });
});

describe('partner', () => {
  test('findActivePartnerByCode : code normalisé (upper+trim) + status active', async () => {
    await repo.findActivePartnerByCode('  ndojo-ab12  ');
    expect(Partner.findOne).toHaveBeenCalledWith({ partnerCode: 'NDOJO-AB12', status: 'active' });
  });

  test('createPartner : new Partner + save (déclenche le hook hash), renvoie le doc', async () => {
    const doc = await repo.createPartner({ email: 'p@x.co', firstName: 'A' });
    expect(doc).toBeInstanceOf(Partner);
    expect(doc.email).toBe('p@x.co');
    expect(Partner.prototype.save).toHaveBeenCalledTimes(1);
  });

  test('findPartnerByEmailWithPassword : findOne(email) + select(+password), sans lean (doc)', () => {
    const q = Partner.findOne();
    Partner.findOne.mockClear();
    Partner.findOne.mockReturnValueOnce(q);
    repo.findPartnerByEmailWithPassword('a@b.co');
    expect(Partner.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('paginatePartners : find(filter) + countDocuments → { data, total }', async () => {
    Partner.__setLean([{ _id: '1' }]);
    const out = await repo.paginatePartners({ status: 'active' }, { skip: 0, limit: 20 });
    expect(Partner.find).toHaveBeenCalledWith({ status: 'active' });
    expect(Partner.countDocuments).toHaveBeenCalledWith({ status: 'active' });
    expect(out).toEqual({ data: [{ _id: '1' }], total: 7 });
  });

  test('setPartnerStatusScoped : findOneAndUpdate scopé { $set: status }, new:true, projection sûre', async () => {
    const q = Partner.findOneAndUpdate();
    Partner.findOneAndUpdate.mockClear();
    Partner.findOneAndUpdate.mockReturnValueOnce(q);
    await repo.setPartnerStatusScoped('p1', { schoolCampus: 'c1' }, 'suspended');
    const [filter, update, opts] = Partner.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'p1', schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { status: 'suspended' } });
    expect(opts).toEqual({ new: true });
    expect(q.select).toHaveBeenCalledWith('-password -__v');
  });

  test('restorePartnerScoped : filtre status archived → active', async () => {
    await repo.restorePartnerScoped('p1', { schoolCampus: 'c1' });
    const [filter, update] = Partner.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'p1', schoolCampus: 'c1', status: 'archived' });
    expect(update).toEqual({ $set: { status: 'active' } });
  });

  test('touchLoginActivity : findByIdAndUpdate lastLoginAt+lastActivityAt + exec', () => {
    const q = Partner.findByIdAndUpdate();
    Partner.findByIdAndUpdate.mockClear();
    Partner.findByIdAndUpdate.mockReturnValueOnce(q);
    repo.touchLoginActivity('p1');
    const [id, update] = Partner.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('p1');
    expect(update.lastLoginAt).toBeInstanceOf(Date);
    expect(update.lastActivityAt).toBeInstanceOf(Date);
    expect(q.exec).toHaveBeenCalled();
  });
});

describe('leads', () => {
  test('findActiveLeadByContact : filtre campus + honeypot false + $or', async () => {
    const dupOr = [{ email: 'x@y.co' }, { phone: '+237' }];
    await repo.findActiveLeadByContact({ campusId: 'c1', dupOr });
    expect(PartnerLead.findOne).toHaveBeenCalledWith({
      schoolCampus: 'c1', honeypotTripped: false, $or: dupOr,
    });
  });

  test('createLead : new PartnerLead + save', async () => {
    const lead = await repo.createLead({ email: 'l@x.co' });
    expect(lead).toBeInstanceOf(PartnerLead);
    expect(PartnerLead.prototype.save).toHaveBeenCalledTimes(1);
  });

  test('applyLeadStatus : $set status + $push statusHistory, scopé, lean virtuals', async () => {
    const q = PartnerLead.findOneAndUpdate();
    PartnerLead.findOneAndUpdate.mockClear();
    PartnerLead.findOneAndUpdate.mockReturnValueOnce(q);
    const entry = { status: 'enrolled', changedBy: 'u1' };
    await repo.applyLeadStatus('l1', { schoolCampus: 'c1' }, 'enrolled', entry);
    const [filter, update, opts] = PartnerLead.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'l1', honeypotTripped: false, schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { status: 'enrolled' }, $push: { statusHistory: entry } });
    expect(opts).toEqual({ new: true });
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
  });

  test('countRecentLeadsByIp : countDocuments ipHash + createdAt $gte + honeypot false', async () => {
    const since = new Date();
    await repo.countRecentLeadsByIp({ ipAddressHash: 'h', since });
    expect(PartnerLead.countDocuments).toHaveBeenCalledWith({
      ipAddressHash: 'h', createdAt: { $gte: since }, honeypotTripped: false,
    });
  });

  test('aggregateLeadConversionStats : pipeline $match fourni + $group total/enrolled', async () => {
    const match = { partner: 'p1', honeypotTripped: false };
    await repo.aggregateLeadConversionStats(match);
    const pipeline = PartnerLead.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toBeNull();
    expect(pipeline[1].$group.total).toEqual({ $sum: 1 });
  });

  test('updateLeadById : $set seul sans historique, $set + $push avec historique', async () => {
    await repo.updateLeadById('l1', { notifyNextBatch: true });
    expect(PartnerLead.findByIdAndUpdate.mock.calls[0][1]).toEqual({ $set: { notifyNextBatch: true } });

    const entry = { status: 'new' };
    await repo.updateLeadById('l2', { city: 'Douala' }, entry);
    expect(PartnerLead.findByIdAndUpdate.mock.calls[1][1]).toEqual({
      $set: { city: 'Douala' }, $push: { statusHistory: entry },
    });
  });
});

describe('commissions', () => {
  test('paginateCommissions : find + populate(partner,lead) + count → { data, total }', async () => {
    PartnerCommission.__setLean([{ _id: 'k1' }]);
    const q = PartnerCommission.find();
    PartnerCommission.find.mockClear();
    PartnerCommission.find.mockReturnValueOnce(q);
    const out = await repo.paginateCommissions({ status: 'pending' }, { skip: 0, limit: 20 });
    expect(PartnerCommission.find).toHaveBeenCalledWith({ status: 'pending' });
    expect(q.populate).toHaveBeenCalledWith('partner', 'firstName lastName partnerCode');
    expect(q.populate).toHaveBeenCalledWith('lead', 'firstName lastName email');
    expect(out).toEqual({ data: [{ _id: 'k1' }], total: 7 });
  });

  test('updateCommissionScoped : findOneAndUpdate scopé { $set }, new:true', async () => {
    await repo.updateCommissionScoped('k1', { schoolCampus: 'c1' }, { status: 'validated' });
    const [filter, update, opts] = PartnerCommission.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'k1', schoolCampus: 'c1' });
    expect(update).toEqual({ $set: { status: 'validated' } });
    expect(opts).toEqual({ new: true });
  });

  test('countBlockingCommissions : status $in pending/validated', async () => {
    await repo.countBlockingCommissions('p1');
    expect(PartnerCommission.countDocuments).toHaveBeenCalledWith({
      partner: 'p1', status: { $in: ['pending', 'validated'] },
    });
  });
});

describe('applications', () => {
  test('paginateApplications : find(filter) + count → { data, total }', async () => {
    PartnerApplication.__setLean([{ _id: 'a1' }]);
    const out = await repo.paginateApplications({ honeypotTripped: false }, { skip: 0, limit: 20 });
    expect(PartnerApplication.find).toHaveBeenCalledWith({ honeypotTripped: false });
    expect(out).toEqual({ data: [{ _id: 'a1' }], total: 7 });
  });

  test('deleteApplicationScoped : true si doc supprimé, false si null', async () => {
    PartnerApplication.__setDelete({ _id: 'a1' });
    expect(await repo.deleteApplicationScoped('a1', { schoolCampus: 'c1' })).toBe(true);
    expect(PartnerApplication.findOneAndDelete).toHaveBeenCalledWith({ _id: 'a1', schoolCampus: 'c1' });

    PartnerApplication.__setDelete(null);
    expect(await repo.deleteApplicationScoped('a2', {})).toBe(false);
  });

  test('createApplication : délègue à PartnerApplication.create', async () => {
    const doc = await repo.createApplication({ email: 'cand@x.co' });
    expect(PartnerApplication.create).toHaveBeenCalledWith({ email: 'cand@x.co' });
    expect(doc._id).toBe('created');
  });
});
