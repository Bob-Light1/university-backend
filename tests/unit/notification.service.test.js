'use strict';

/**
 * Socle notifications — service (Phase 2).
 * Vérifie la logique de `notify` (une ligne par canal, rendu de template,
 * livraison best-effort), les statuts (sent / skipped / failed), et le worker de
 * retry. Repository et canaux mockés — aucune DB, aucun appel externe.
 */

jest.mock('../../modules/notification/notification.repository');
jest.mock('../../modules/notification/channels');

const repo     = require('../../modules/notification/notification.repository');
const channels = require('../../modules/notification/channels');
const service  = require('../../modules/notification/notification.service');

// Canal factice configurable.
const makeChannel = (over = {}) => ({
  isConfigured: jest.fn(() => true),
  send: jest.fn().mockResolvedValue({ ok: true }),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // createMany renvoie les lignes enrichies d'un _id (ordre préservé).
  repo.createMany.mockImplementation((rows) =>
    Promise.resolve(rows.map((r, i) => ({ _id: `n${i}`, ...r })))
  );
  repo.markSent.mockResolvedValue({ modifiedCount: 1 });
  repo.markSkipped.mockResolvedValue({ modifiedCount: 1 });
  repo.markFailed.mockResolvedValue({ modifiedCount: 1 });
});

const recipient = { id: 'u1', model: 'Student', email: 'a@b.c', phone: '+237600000000', campusId: 'c1', locale: 'fr' };

describe('notify', () => {
  test('crée une ligne par canal, avec le bon destinataire et la bonne coordonnée', async () => {
    channels.get.mockImplementation(() => makeChannel());

    await service.notify({
      recipient,
      channels: ['inapp', 'email'],
      template: 'generic',
      data: { subject: 'Hi', body: 'Body' },
    });

    expect(repo.createMany).toHaveBeenCalledTimes(1);
    const rows = repo.createMany.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel)).toEqual(['inapp', 'email']);
    expect(rows[0].to).toBeNull();              // inapp : pas de coordonnée
    expect(rows[1].to).toBe('a@b.c');           // email : adresse du destinataire
    expect(rows[0].recipientId).toBe('u1');
    expect(rows[0].schoolCampus).toBe('c1');
    expect(rows[1].locale).toBe('fr');          // locale du destinataire
  });

  test('canal in-app → marqué sent (persistance = livraison)', async () => {
    channels.get.mockImplementation(() => makeChannel());
    await service.notify({ recipient, channels: ['inapp'], template: 'generic', data: { body: 'x' } });
    expect(repo.markSent).toHaveBeenCalledWith('n0');
  });

  test('canal externe non configuré → skipped, jamais d\'erreur', async () => {
    channels.get.mockImplementation((name) =>
      name === 'inapp' ? makeChannel() : makeChannel({ isConfigured: () => false })
    );
    await service.notify({ recipient, channels: ['email'], template: 'generic', data: { body: 'x' } });
    expect(repo.markSkipped).toHaveBeenCalledWith('n0', expect.stringMatching(/not configured/));
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  test('coordonnée manquante → skipped', async () => {
    channels.get.mockImplementation(() => makeChannel());
    await service.notify({
      recipient: { id: 'u1', model: 'Student' }, // ni email ni phone
      channels: ['email'],
      template: 'generic',
      data: { body: 'x' },
    });
    expect(repo.markSkipped).toHaveBeenCalledWith('n0', expect.stringMatching(/No email address/));
  });

  test('échec d\'envoi → markFailed (best-effort, ne propage pas)', async () => {
    const boom = makeChannel({ send: jest.fn().mockRejectedValue(new Error('SMTP down')) });
    channels.get.mockImplementation((name) => (name === 'email' ? boom : makeChannel()));
    await expect(
      service.notify({ recipient, channels: ['email'], template: 'generic', data: { body: 'x' } })
    ).resolves.toBeDefined();
    expect(repo.markFailed).toHaveBeenCalledWith('n0', 'SMTP down');
  });

  test('template inconnu → rejette', async () => {
    await expect(
      service.notify({ recipient, channels: ['inapp'], template: 'does.not.exist' })
    ).rejects.toThrow(/unknown template/);
  });

  test('destinataire invalide → rejette', async () => {
    await expect(
      service.notify({ recipient: { id: 'u1' }, template: 'generic' })
    ).rejects.toThrow(/recipient/);
  });

  test('défaut = canal inapp si aucun canal fourni', async () => {
    channels.get.mockImplementation(() => makeChannel());
    await service.notify({ recipient, template: 'generic', data: { body: 'x' } });
    const rows = repo.createMany.mock.calls[0][0];
    expect(rows.map((r) => r.channel)).toEqual(['inapp']);
  });
});

describe('runRetryJob', () => {
  test('rejoue chaque envoi récupérable et agrège les statuts', async () => {
    repo.findDeliverable.mockResolvedValue([
      { _id: 'a', channel: 'email', to: 'a@b.c', subject: 's', body: 'b' },
      { _id: 'b', channel: 'whatsapp', to: '+237', subject: null, body: 'b' },
    ]);
    channels.get.mockImplementation((name) =>
      name === 'email'
        ? makeChannel()
        : makeChannel({ send: jest.fn().mockRejectedValue(new Error('429')) })
    );

    const res = await service.runRetryJob();
    expect(res.processed).toBe(2);
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(repo.markSent).toHaveBeenCalledWith('a');
    expect(repo.markFailed).toHaveBeenCalledWith('b', '429');
  });
});

describe('templates', () => {
  const templates = require('../../modules/notification/templates');

  test('result.published rend un contenu localisé (fr) sur les 3 canaux', () => {
    expect(templates.has('result.published')).toBe(true);
    const inapp = templates.render('result.published', 'inapp', {}, 'fr');
    expect(inapp.subject).toMatch(/résultat/i);
    expect(inapp.body).toMatch(/publié/i);
    expect(templates.render('result.published', 'email', { name: 'Alice' }, 'fr').body).toMatch(/Alice/);
    expect(templates.render('result.published', 'whatsapp', {}, 'en').body).toMatch(/result/i);
  });

  test('interpolation et repli en par défaut', () => {
    const out = templates.render('payment.reminder', 'inapp', { amount: 500, currency: 'XAF', dueDate: '2026-07-01' }, 'xx');
    expect(out.body).toContain('500');
    expect(out.body).toContain('XAF'); // locale inconnue → repli en
  });
});

describe('inbox helpers', () => {
  test('markRead renvoie true quand une ligne est modifiée', async () => {
    repo.markRead.mockResolvedValue({ modifiedCount: 1 });
    await expect(service.markRead('id', 'u1')).resolves.toBe(true);
    expect(repo.markRead).toHaveBeenCalledWith('id', 'u1');
  });

  test('markRead renvoie false quand rien n\'est modifié (anti-IDOR)', async () => {
    repo.markRead.mockResolvedValue({ modifiedCount: 0 });
    await expect(service.markRead('id', 'other')).resolves.toBe(false);
  });
});
