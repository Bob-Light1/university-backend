'use strict';

/**
 * @file competition.closing.cron.test.js
 * @description The monthly competition closing, under per-campus entitlement —
 * `docs/architecture/CAMPUS_ENTITLEMENT_DESIGN.md` §9.1.
 *
 * This job is the one that proves "module off ⇒ job off" is the wrong rule. It
 * does two things of opposite natures in the same function:
 *
 *  - it SETTLES the ranking and flips the competition inactive — hygiene. A
 *    competition left active past its period never closes, and its winners keep
 *    drifting with sessions played after the fact. It must run whatever the
 *    campus's entitlement says.
 *  - it MAILS the winners — emission, in the name of the public portal. That is
 *    what a campus switching the portal off has asked to stop.
 *
 * Deriving the behaviour from the job's declared `nature` alone would have given
 * one of the two, never both.
 */

jest.mock('../../modules/public-portal/public-portal.repository');
jest.mock('../../modules/public-portal/notification.service', () => ({
  notifyWinners: jest.fn().mockResolvedValue({ notified: 3 }),
}));
jest.mock('../../shared/lib/entitlement', () => ({
  jobs: { isEmissionAllowed: jest.fn().mockResolvedValue(true) },
}));

const repo = require('../../modules/public-portal/public-portal.repository');
const { notifyWinners } = require('../../modules/public-portal/notification.service');
const { jobs: entitlementJobs } = require('../../shared/lib/entitlement');
const { closeCompetition } = require('../../modules/public-portal/competition.closing.cron');

const CAMPUS_ID = '507f1f77bcf86cd799439012';
const COMP_ID   = '507f1f77bcf86cd799439013';

/** A due competition, plus the sessions that decide its ranking. */
const dueCompetition = () => {
  const competition = {
    _id: COMP_ID, schoolCampus: CAMPUS_ID, period: '2026-07', isActive: true, winners: [],
  };
  repo.findCompetitionByIdForWrite.mockResolvedValue(competition);
  repo.findTopQuizSessions.mockResolvedValue([
    { _id: 's1', displayName: 'Ada',  score: 92, lead: null },
    { _id: 's2', displayName: 'Grace', score: 81, lead: null },
  ]);
  repo.saveCompetitionDoc.mockResolvedValue(competition);
  return competition;
};

beforeEach(() => {
  jest.clearAllMocks();
  entitlementJobs.isEmissionAllowed.mockResolvedValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('closeCompetition — portal active', () => {
  test('settles the ranking and notifies the winners', async () => {
    const competition = dueCompetition();

    const result = await closeCompetition(COMP_ID);

    expect(competition.isActive).toBe(false);
    expect(competition.winners).toHaveLength(2);
    expect(notifyWinners).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ winners: 2, notified: 3 });
  });
});

describe('closeCompetition — portal not active on this campus', () => {
  test('still closes and still freezes the winners', async () => {
    // The hygiene half is not negotiable: an unclosed competition stays live
    // forever, and its ranking keeps moving. Nothing is lost by the refusal —
    // the winners are on the record, only the outbound message is withheld.
    entitlementJobs.isEmissionAllowed.mockResolvedValue(false);
    const competition = dueCompetition();

    const result = await closeCompetition(COMP_ID);

    expect(entitlementJobs.isEmissionAllowed).toHaveBeenCalledWith(CAMPUS_ID, 'public-portal');
    expect(competition.isActive).toBe(false);
    expect(competition.winners).toHaveLength(2);
    expect(repo.saveCompetitionDoc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ winners: 2, notified: 0 });
  });

  test('sends nothing', async () => {
    entitlementJobs.isEmissionAllowed.mockResolvedValue(false);
    dueCompetition();

    await closeCompetition(COMP_ID);

    expect(notifyWinners).not.toHaveBeenCalled();
  });

  test('the campus checked is the competition\'s own, not a global one', async () => {
    // The job sweeps the whole estate in one pass: reading the entitlement of
    // anything but the row's own campus would silence — or unsilence — every
    // other tenant along with it.
    dueCompetition();

    await closeCompetition(COMP_ID);

    expect(entitlementJobs.isEmissionAllowed).toHaveBeenCalledWith(CAMPUS_ID, 'public-portal');
  });
});

describe('closeCompetition — nothing to do', () => {
  test('an already-closed competition is left alone and asks nothing', async () => {
    repo.findCompetitionByIdForWrite.mockResolvedValue({
      _id: COMP_ID, schoolCampus: CAMPUS_ID, isActive: false, winners: [],
    });

    const result = await closeCompetition(COMP_ID);

    expect(result).toEqual({ winners: 0 });
    expect(entitlementJobs.isEmissionAllowed).not.toHaveBeenCalled();
    expect(notifyWinners).not.toHaveBeenCalled();
  });
});
