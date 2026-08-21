'use strict';

/**
 * @file exam-anticheat.cron.test.js
 * @description Regression tests for defects B9-④, B9-⑤ and B9-⑦ — the job around the metric.
 *
 * B9-④ — "not yet scanned" meant "completed in the last 48 h", evaluated by a job running
 *        every 24 h. Every session was therefore selected on two consecutive nights, and
 *        with an append-only `$push` every finding was recorded twice.
 * B9-⑤ — the batch was an UNSORTED `.limit(50)`. Nothing drained, so the 51st session in a
 *        window was never scanned, and which 50 were returned was unspecified.
 * B9-⑦ — two `await`ed writes per flagged pair, issued from inside the O(n²) loop, under a
 *        comment reading "non-blocking, fire-and-forget".
 *
 * The decisive assertions are about the OUTSTANDING set and the write COUNT, not about what
 * the job reports having done — a job can only report what it did, which is exactly what
 * hid both of the first two defects.
 */

jest.mock('../../modules/exam/exam.repository');
// The per-campus emission gate is pinned in tests/unit/entitlement.jobs.test.js;
// here it is stubbed so the job's own behaviour is what these tests measure.
jest.mock('../../shared/lib/entitlement', () => ({
  jobs: { suppressedCampusIds: jest.fn().mockResolvedValue([]) },
}));

const repo = require('../../modules/exam/exam.repository');
const { jobs: entitlementJobs } = require('../../shared/lib/entitlement');
const { runAntiCheatJob, analyzeSession } = require('../../modules/exam/exam-anticheat.cron');

const SESSION_A = '507f1f77bcf86cd799439011';
const SESSION_B = '507f1f77bcf86cd799439012';

/**
 * In-memory session store: `findSessionsPendingAntiCheat` serves only unscanned sessions
 * and `markSessionAntiCheatScanned` removes them from that set — so the suite can assert
 * that the candidate set actually drains across runs.
 */
const buildStore = (sessions) => {
  const store = new Map(sessions.map((s) => [String(s._id), { ...s }]));

  repo.findSessionsPendingAntiCheat.mockImplementation(async (limit) =>
    [...store.values()]
      .filter((s) => !s.antiCheatScannedAt)
      .sort((a, b) => a.completedAt - b.completedAt)
      .slice(0, limit)
      .map((s) => ({ ...s })));

  repo.countSessionsPendingAntiCheat.mockImplementation(async () =>
    [...store.values()].filter((s) => !s.antiCheatScannedAt).length);

  repo.markSessionAntiCheatScanned.mockImplementation(async (id, at = new Date()) => {
    const s = store.get(String(id));
    if (s) s.antiCheatScannedAt = at;
  });

  repo.findSessionByIdLean.mockImplementation(async (id) => store.get(String(id)) ?? null);

  return store;
};

/** A session of `n` students who all submitted the identical paper. */
const identicalPapers = (n) => {
  const questions = Array.from({ length: 8 }, (_, i) => ({ questionId: `q${i}` }));
  const answers = questions.map((q, i) => ({ questionId: q.questionId, selectedOption: i % 4 }));
  return {
    questions,
    submissions: Array.from({ length: n }, (_, i) => ({
      _id: `sub${i}`, student: `stu${i}`, answers: [...answers],
    })),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  entitlementJobs.suppressedCampusIds.mockResolvedValue([]);
  repo.bulkPushAntiCheatFlags.mockResolvedValue(null);
  repo.findSubmissionsForAntiCheat.mockResolvedValue([]);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('B9-④ — a session is scanned once, not once per nightly pass', () => {
  test('the second run finds nothing left to do', async () => {
    const { questions, submissions } = identicalPapers(2);
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);

    const first = await runAntiCheatJob();
    expect(first.sessions).toBe(1);
    expect(first.totalFlagged).toBe(1);

    const second = await runAntiCheatJob();
    // The defect in one assertion: under the 48 h window this was 1 again, and the pair was
    // flagged a second time on the same two submissions.
    expect(second.sessions).toBe(0);
    expect(second.totalFlagged).toBe(0);
  });

  test('the flags are written once across two runs', async () => {
    const { questions, submissions } = identicalPapers(2);
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);

    await runAntiCheatJob();
    await runAntiCheatJob();

    const written = repo.bulkPushAntiCheatFlags.mock.calls.flatMap(([ops]) => ops);
    expect(written).toHaveLength(2); // one flagged pair → one flag on each submission
  });

  test('the session is stamped scanned', async () => {
    const { questions, submissions } = identicalPapers(2);
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);

    await runAntiCheatJob();

    expect(repo.markSessionAntiCheatScanned).toHaveBeenCalledWith(SESSION_A);
  });
});

describe('B9-⑤ — the candidate set drains, oldest first', () => {
  /** 120 sessions, none scanned, each with no questions so the scan is trivial. */
  // 24-hex-character ids: `analyzeSession` validates the id before doing anything, so a
  // malformed one returns early — and, correctly, without stamping a session that does not
  // exist. Building them wrong here would test that path instead of the drain.
  const backlog = (n) => Array.from({ length: n }, (_, i) => ({
    _id: `5f7f1f77bcf86cd799439${String(i).padStart(3, '0')}`,
    completedAt: new Date(2026, 5, 1, 0, i),
    questions: [],
    antiCheatScannedAt: null,
  }));

  test('a backlog larger than one batch is fully drained across runs', async () => {
    const store = buildStore(backlog(120));

    // Batch size is 50, so three runs must clear 120 — and, decisively, the OUTSTANDING
    // count must reach zero. Under the old unsorted `.limit(50)` with no marker it never
    // did: nothing drained, so sessions 51+ were never reached.
    await runAntiCheatJob();
    await runAntiCheatJob();
    const third = await runAntiCheatJob();

    expect(third.remaining).toBe(0);
    expect([...store.values()].every((s) => s.antiCheatScannedAt)).toBe(true);
  });

  test('the run reports what is still outstanding, not only what it processed', async () => {
    buildStore(backlog(120));

    const first = await runAntiCheatJob();

    expect(first.sessions).toBe(50);
    expect(first.remaining).toBe(70);
  });

  test('the oldest sessions are taken first', async () => {
    const store = buildStore(backlog(60));

    await runAntiCheatJob();

    const scanned = [...store.values()].filter((s) => s.antiCheatScannedAt);
    const pending = [...store.values()].filter((s) => !s.antiCheatScannedAt);
    const newestScanned = Math.max(...scanned.map((s) => s.completedAt.getTime()));
    const oldestPending = Math.min(...pending.map((s) => s.completedAt.getTime()));

    expect(newestScanned).toBeLessThan(oldestPending);
  });

  test('a session that throws keeps its null marker and is retried', async () => {
    const store = buildStore([
      { _id: SESSION_A, completedAt: new Date('2026-06-01'), questions: [{ questionId: 'q0' }], antiCheatScannedAt: null },
    ]);
    repo.findSubmissionsForAntiCheat.mockRejectedValueOnce(new Error('mongo is away'));

    const run = await runAntiCheatJob();

    expect(run.sessions).toBe(0);
    expect(run.remaining).toBe(1);
    expect(store.get(SESSION_A).antiCheatScannedAt).toBeFalsy();
  });

  test('a session with nothing to compare is still stamped, not left as a permanent candidate', async () => {
    const store = buildStore([
      { _id: SESSION_B, completedAt: new Date('2026-06-01'), questions: [], antiCheatScannedAt: null },
    ]);

    await runAntiCheatJob();

    expect(store.get(SESSION_B).antiCheatScannedAt).toBeTruthy();
  });
});

describe('B9-⑦ — the pairwise loop performs no I/O', () => {
  test('a 30-student session issues ONE bulk write, not one per flagged pair', async () => {
    const { questions, submissions } = identicalPapers(30);
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);

    const result = await analyzeSession(SESSION_A);

    // 30 identical papers → C(30,2) = 435 flagged pairs. The old code awaited two writes
    // per pair from inside the loop: 870 round trips, serialized.
    expect(result.flagged).toBe(435);
    expect(repo.bulkPushAntiCheatFlags).toHaveBeenCalledTimes(1);
    expect(repo.bulkPushAntiCheatFlags.mock.calls[0][0]).toHaveLength(870);
    expect(repo.pushAntiCheatFlag).not.toHaveBeenCalled();
  });

  test('flags are written BEFORE the session is stamped scanned', async () => {
    const order = [];
    const { questions, submissions } = identicalPapers(2);
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);
    repo.bulkPushAntiCheatFlags.mockImplementation(async () => { order.push('flags'); });
    repo.markSessionAntiCheatScanned.mockImplementation(async () => { order.push('stamp'); });

    await analyzeSession(SESSION_A);

    // A run dying between the two must re-scan, not mark a session done with its findings
    // missing. The reverse order loses them permanently.
    expect(order).toEqual(['flags', 'stamp']);
  });

  test('a session whose papers agree on nothing writes no flags', async () => {
    const questions = Array.from({ length: 8 }, (_, i) => ({ questionId: `q${i}` }));
    const submissions = [
      { _id: 'sub0', student: 'stu0', answers: questions.map((q) => ({ questionId: q.questionId, selectedOption: 0 })) },
      { _id: 'sub1', student: 'stu1', answers: questions.map((q) => ({ questionId: q.questionId, selectedOption: 1 })) },
    ];
    buildStore([{ _id: SESSION_A, completedAt: new Date('2026-06-01'), questions, antiCheatScannedAt: null }]);
    repo.findSubmissionsForAntiCheat.mockResolvedValue(submissions);

    const result = await analyzeSession(SESSION_A);

    // Under cosine these two vectors were proportional → similarity 1.0 → flagged.
    expect(result.flagged).toBe(0);
    expect(repo.bulkPushAntiCheatFlags).toHaveBeenCalledWith([]);
  });
});

describe('entitlement — a campus whose Examinations module is off takes no scan (§9.1)', () => {
  test('the exclusion reaches BOTH queries, batch and backlog figure', async () => {
    // Flagging a submission is a verdict issued in the module's name: emission,
    // not hygiene. Excluded inside the query rather than after the read — a
    // batch filtered afterwards would return mostly rows the job may not touch,
    // starve the campuses it may, and re-fill identically on the next run
    // because those sessions keep their null marker.
    entitlementJobs.suppressedCampusIds.mockResolvedValue(['camp-off']);
    buildStore([]);

    await runAntiCheatJob();

    expect(entitlementJobs.suppressedCampusIds).toHaveBeenCalledWith('exam');
    expect(repo.findSessionsPendingAntiCheat)
      .toHaveBeenCalledWith(expect.any(Number), { excludeCampusIds: ['camp-off'] });
    // The backlog figure carries it too: a count including sessions the job is
    // forbidden to scan would grow forever and read as a failing job.
    expect(repo.countSessionsPendingAntiCheat)
      .toHaveBeenCalledWith({ excludeCampusIds: ['camp-off'] });
  });
});
