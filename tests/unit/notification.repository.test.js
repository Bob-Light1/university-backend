'use strict';

/**
 * Socle notifications — repository (Phase 2).
 * Verrouille les filtres (boîte in-app, non-lus, anti-IDOR du markRead, sélection
 * du worker de retry) et les opérateurs atomiques de statut. Model mocké, sans DB.
 */

jest.mock('../../modules/notification/models/notification.model', () => {
  const makeChain = (result) => {
    const q = {};
    q.sort = jest.fn(() => q);
    q.skip = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.lean = jest.fn().mockResolvedValue(result);
    return q;
  };
  return {
    insertMany:     jest.fn((rows) => Promise.resolve(rows.map((r, i) => ({ _id: `n${i}`, ...r })))),
    find:           jest.fn(() => makeChain([{ _id: '1' }])),
    findById:       jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ _id: '1' }) })),
    countDocuments: jest.fn().mockResolvedValue(7),
    updateOne:      jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany:     jest.fn().mockResolvedValue({ modifiedCount: 4 }),
    CHANNELS: ['inapp', 'email', 'whatsapp'],
  };
});

const Notification = require('../../modules/notification/models/notification.model');
const repo = require('../../modules/notification/notification.repository');

beforeEach(() => jest.clearAllMocks());

describe('boîte de réception in-app', () => {
  test('findInbox filtre sur le canal inapp et trie par date décroissante', async () => {
    await repo.findInbox({ recipientId: 'u1', skip: 0, limit: 10 });
    expect(Notification.find).toHaveBeenCalledWith({ recipientId: 'u1', channel: 'inapp' });
    const chain = Notification.find.mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  test('findInbox unreadOnly ajoute readAt:null', async () => {
    await repo.findInbox({ recipientId: 'u1', unreadOnly: true });
    expect(Notification.find).toHaveBeenCalledWith({ recipientId: 'u1', channel: 'inapp', readAt: null });
  });

  test('countUnread compte les inapp non lus', async () => {
    await repo.countUnread('u1');
    expect(Notification.countDocuments).toHaveBeenCalledWith({ recipientId: 'u1', channel: 'inapp', readAt: null });
  });
});

describe('markRead — anti-IDOR', () => {
  test('cible la ligne du destinataire, in-app, non lue', async () => {
    await repo.markRead('id1', 'u1');
    expect(Notification.updateOne).toHaveBeenCalledWith(
      { _id: 'id1', recipientId: 'u1', channel: 'inapp', readAt: null },
      { $set: { status: 'read', readAt: expect.any(Date) } }
    );
  });
});

describe('worker de retry', () => {
  test('findDeliverable ne prend que les envois externes récupérables', async () => {
    await repo.findDeliverable(50);
    expect(Notification.find).toHaveBeenCalledWith({
      channel: { $in: ['email', 'whatsapp'] },
      status:  { $in: ['pending', 'failed'] },
      $expr:   { $lt: ['$attempts', '$maxAttempts'] },
    });
  });
});

describe('statuts atomiques', () => {
  test('markSent passe à sent + horodate + incrémente attempts', async () => {
    await repo.markSent('id1');
    expect(Notification.updateOne).toHaveBeenCalledWith(
      { _id: 'id1' },
      { $set: { status: 'sent', sentAt: expect.any(Date), lastError: null }, $inc: { attempts: 1 } }
    );
  });

  test('markFailed tronque l\'erreur et incrémente attempts', async () => {
    await repo.markFailed('id1', 'x'.repeat(800));
    const call = Notification.updateOne.mock.calls[0][1];
    expect(call.$set.status).toBe('failed');
    expect(call.$set.lastError.length).toBe(500);
    expect(call.$inc).toEqual({ attempts: 1 });
  });
});

describe('journal admin', () => {
  test('paginateLog fusionne le filtre campus + filtres optionnels', async () => {
    await repo.paginateLog({ campusFilter: { schoolCampus: 'c1' }, channel: 'email', status: 'failed', skip: 0, limit: 20 });
    expect(Notification.find).toHaveBeenCalledWith(
      expect.objectContaining({ schoolCampus: 'c1', channel: 'email', status: 'failed' })
    );
  });
});
