'use strict';

/**
 * Queue worker logic for academic-print batch jobs (print-job.processor.js).
 *
 * Locks the multi-process-safe contract introduced when JOBS moved from an
 * in-process Map to MongoDB persistence:
 *   - claimAndProcess only runs a job it atomically claimed (else no-op);
 *   - progress is pushed per target; final status reflects success/failure mix;
 *   - external cancellation stops processing;
 *   - the sweep requeues stale jobs then drains pending ones.
 *
 * All collaborators (repository, PDF engine, cross-module facades) are mocked —
 * no DB, no Puppeteer.
 */

jest.mock('../../modules/academic-print/print-job.repository');
jest.mock('../../modules/academic-print/academic-pdf.service', () => ({
  generateAcademicPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  savePrintPdf:        jest.fn().mockResolvedValue('/tmp/x.pdf'),
}));
jest.mock('../../modules/student', () => ({
  service: {
    getStudentForPrint: jest.fn(),
    listClassStudentsForCards: jest.fn(),
    listClassStudentsForList: jest.fn(),
    getStudentNamesByIds: jest.fn(),
    listSessionsForClass: jest.fn(),
  },
}));
jest.mock('../../modules/class', () => ({
  service: { getClassName: jest.fn().mockResolvedValue({ className: 'CM1' }), getClassNameInCampus: jest.fn() },
}));
jest.mock('../../modules/result', () => ({ service: { getTranscriptForPrint: jest.fn() } }));

const repo            = require('../../modules/academic-print/print-job.repository');
const studentService  = require('../../modules/student').service;
const processor       = require('../../modules/academic-print/print-job.processor');

const makeJob = (overrides = {}) => ({
  _id:      'job-1',
  type:     'STUDENT_CARD',
  campusId: 'campus-1',
  params:   {},
  targets:  [{ id: 's1', name: 'A A' }, { id: 's2', name: 'B B' }],
  progress: { total: 2, done: 0, failed: 0 },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  // default: heartbeat returns a live PROCESSING job (not cancelled/gone)
  repo.touchProcessing.mockResolvedValue({ status: 'PROCESSING' });
  repo.pushSuccess.mockResolvedValue({});
  repo.pushFailure.mockResolvedValue({});
  repo.finalize.mockResolvedValue({});
  studentService.getStudentForPrint.mockResolvedValue({ _id: 's1', matricule: 'M1' });
});

describe('atomic claim safety', () => {
  test('a job already claimed by another worker is not processed', async () => {
    repo.requeueStale.mockResolvedValue({});
    repo.findClaimablePendingIds.mockResolvedValue([{ _id: 'job-1' }]);
    repo.claim.mockResolvedValue(null); // claim lost the race

    const processed = await processor.runPrintQueueJob();

    expect(repo.claim).toHaveBeenCalledWith('job-1');
    expect(repo.pushSuccess).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
    expect(processed).toBe(0);
  });
});

describe('runPrintQueueJob (sweep)', () => {
  test('requeues stale jobs then claims & processes pending ones → DONE', async () => {
    repo.requeueStale.mockResolvedValue({});
    repo.findClaimablePendingIds.mockResolvedValue([{ _id: 'job-1' }]);
    repo.claim.mockResolvedValue(makeJob());

    const processed = await processor.runPrintQueueJob();

    expect(repo.requeueStale).toHaveBeenCalledTimes(1);
    expect(repo.claim).toHaveBeenCalledWith('job-1');
    expect(repo.pushSuccess).toHaveBeenCalledTimes(2);
    expect(repo.pushFailure).not.toHaveBeenCalled();
    expect(repo.finalize).toHaveBeenCalledWith('job-1', 'DONE');
    expect(processed).toBe(1);
  });

  test('mixed success/failure → PARTIAL', async () => {
    repo.requeueStale.mockResolvedValue({});
    repo.findClaimablePendingIds.mockResolvedValue([{ _id: 'job-1' }]);
    repo.claim.mockResolvedValue(makeJob());
    // second target: student not found → loadStudent throws
    studentService.getStudentForPrint
      .mockResolvedValueOnce({ _id: 's1', matricule: 'M1' })
      .mockResolvedValueOnce(null);

    await processor.runPrintQueueJob();

    expect(repo.pushSuccess).toHaveBeenCalledTimes(1);
    expect(repo.pushFailure).toHaveBeenCalledTimes(1);
    expect(repo.finalize).toHaveBeenCalledWith('job-1', 'PARTIAL');
  });

  test('all targets fail → ERROR', async () => {
    repo.requeueStale.mockResolvedValue({});
    repo.findClaimablePendingIds.mockResolvedValue([{ _id: 'job-1' }]);
    repo.claim.mockResolvedValue(makeJob());
    studentService.getStudentForPrint.mockResolvedValue(null); // every target fails

    await processor.runPrintQueueJob();

    expect(repo.pushSuccess).not.toHaveBeenCalled();
    expect(repo.pushFailure).toHaveBeenCalledTimes(2);
    expect(repo.finalize).toHaveBeenCalledWith('job-1', 'ERROR');
  });

  test('external cancellation stops processing before finalize', async () => {
    repo.requeueStale.mockResolvedValue({});
    repo.findClaimablePendingIds.mockResolvedValue([{ _id: 'job-1' }]);
    repo.claim.mockResolvedValue(makeJob());
    repo.touchProcessing.mockResolvedValue(null); // cancelled/gone → stop

    await processor.runPrintQueueJob();

    expect(repo.pushSuccess).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
  });
});
