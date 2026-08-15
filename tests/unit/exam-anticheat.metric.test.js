'use strict';

/**
 * @file exam-anticheat.metric.test.js
 * @description Regression tests for defect B9-⑥ — the anti-cheat measure itself.
 *
 * The job scored MCQ papers with a cosine similarity over `selectedOption` values. Those
 * values are option INDICES — labels, not quantities — so a geometric measure over them
 * answers a question nobody asked, and it answered it wrongly in both directions:
 *
 *   cosine([3,3,3], [1,1,1]) === 1.0   zero shared answers, rated identical
 *   cosine([0,0,0], [0,0,0]) === 0.0   the archetypal copied paper, rated unrelated
 *
 * The old implementation is reproduced verbatim below and asserted against, so these are
 * not claims about it — they are executions of it. The exhaustive test at the end is the
 * one that matters: it quantifies the false-positive rate over every three-question,
 * four-option pair rather than trusting a handful of hand-picked cases.
 */

const {
  answerAgreement, shouldFlag, shouldRescan, buildFlagWrites,
} = require('../../modules/exam/exam-anticheat.metric');

const RULES = { threshold: 0.85, minCommon: 5 };

/** The replaced `_cosineSimilarity`, copied verbatim from the pre-fix cron. */
const cosine = (vecA, vecB) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i] < 0 ? 0 : vecA[i];
    const b = vecB[i] < 0 ? 0 : vecB[i];
    dot += a * b; normA += a * a; normB += b * b;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

describe('B9-⑥ — the cases the replaced measure got wrong', () => {
  test('two identical all-option-0 papers: cosine says 0.0, agreement says 1.0', () => {
    const paper = [0, 0, 0];

    expect(cosine(paper, paper)).toBe(0);          // the archetypal copied paper, unflagged
    expect(answerAgreement(paper, paper).score).toBe(1);
  });

  test('papers sharing ZERO answers: cosine says 1.0, agreement says 0.0', () => {
    for (const [a, b] of [[[3, 3, 3], [1, 1, 1]], [[1, 2, 3], [2, 4, 6]]]) {
      expect(cosine(a, b)).toBe(1);                // baseline: the old code flags this pair
      const agreement = answerAgreement(a, b);
      expect(agreement.score).toBe(0);
      expect(agreement.matched).toBe(0);
      expect(agreement.common).toBe(3);
    }
  });

  test('option 0 counts exactly like any other option', () => {
    // The clamp `vecA[i] < 0 ? 0 : vecA[i]` folded "unanswered" onto option 0 and then a
    // zero norm discarded the row entirely. Equality has no such special case.
    expect(answerAgreement([0, 1, 0], [0, 1, 0]).score).toBe(1);
    expect(answerAgreement([0, 0, 0], [1, 1, 1]).score).toBe(0);
  });

  test('19 agreements out of 20 scores exactly 0.95 and flags', () => {
    const a = Array.from({ length: 20 }, (_, i) => i % 4);
    const b = [...a];
    b[19] = (b[19] + 1) % 4;

    const agreement = answerAgreement(a, b);
    expect(agreement).toMatchObject({ common: 20, matched: 19, score: 0.95 });
    expect(shouldFlag(agreement, RULES)).toBe(true);
  });
});

describe('answerAgreement — blanks are absence of evidence', () => {
  test('one blank, one answered: the question is excluded entirely', () => {
    const agreement = answerAgreement([1, 2, 3], [1, null, 3]);
    expect(agreement.common).toBe(2);
    expect(agreement.score).toBe(1);
    expect(agreement.bothBlank).toBe(0);
  });

  test('both blank: counted separately, never folded into the score', () => {
    const a = [1, 1, 1, 1, 1, 1, -1, -1, -1];
    const agreement = answerAgreement(a, [...a]);

    expect(agreement.common).toBe(6);
    expect(agreement.score).toBe(1);
    // Simultaneous abandonment is arguably a strong signal, but it is evidence of a
    // different kind — it says nothing about the CONTENT of the answers.
    expect(agreement.bothBlank).toBe(3);
  });

  test('a pair who answered nothing scores null, not 1.0', () => {
    const agreement = answerAgreement([-1, -1, -1], [null, null, null]);
    expect(agreement.score).toBeNull();
    expect(agreement.bothBlank).toBe(3);
    expect(shouldFlag(agreement, RULES)).toBe(false);
  });

  test('no commonly-answered question: null, which is not the same fact as 0', () => {
    const agreement = answerAgreement([1, 2, null, null], [null, null, 3, 4]);
    expect(agreement.score).toBeNull();
    expect(agreement.common).toBe(0);
    expect(shouldFlag(agreement, RULES)).toBe(false);
  });

  test('-1, null and undefined are all read as blank', () => {
    expect(answerAgreement([-1, 1], [null, 1]).common).toBe(1);
    expect(answerAgreement([undefined, 1], [-1, 1]).common).toBe(1);
  });

  test('misaligned vectors throw rather than comparing different questions', () => {
    expect(() => answerAgreement([1, 2], [1, 2, 3])).toThrow(/aligned/);
  });
});

describe('shouldFlag — the floor on the denominator', () => {
  test('a perfect 2-of-2 does not outrank a 47-of-50', () => {
    const short = answerAgreement([1, 2, null, null, null, null], [1, 2, null, null, null, null]);
    expect(short.score).toBe(1);   // the ratio really is 1.0 — that is the problem
    expect(short.common).toBe(2);
    expect(shouldFlag(short, RULES)).toBe(false);
  });

  test('the floor is a knob, not a law', () => {
    const short = answerAgreement([1, 2], [1, 2]);
    expect(shouldFlag(short, { threshold: 0.85, minCommon: 2 })).toBe(true);
  });

  test('exactly at the threshold flags — the comparison is >=', () => {
    const a = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
    const b = [...a];
    b[0] = 3; b[1] = 0; b[2] = 1;   // 17/20 = 0.85
    const agreement = answerAgreement(a, b);

    expect(agreement.score).toBe(0.85);
    expect(shouldFlag(agreement, RULES)).toBe(true);
  });
});

describe('B9-⑥ — exhaustive: every 3-question, 4-option pair', () => {
  // 4³ = 64 possible papers → 64 × 64 = 4096 ordered pairs. The point of running all of
  // them is that the false-positive rate is a measured number, not an impression.
  const papers = [];
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      for (let c = 0; c < 4; c++) papers.push([a, b, c]);
    }
  }

  test('cosine crossed 0.85 on 16.0% of the ZERO-agreement pairs', () => {
    let zeroAgreement = 0;
    let falsePositives = 0;

    for (const p of papers) {
      for (const q of papers) {
        if (answerAgreement(p, q).matched !== 0) continue;
        zeroAgreement += 1;
        if (cosine(p, q) >= 0.85) falsePositives += 1;
      }
    }

    expect(zeroAgreement).toBe(1728);
    expect(falsePositives).toBe(276);
    expect(falsePositives / zeroAgreement).toBeCloseTo(0.16, 2);
  });

  test('the agreement measure flags no zero-agreement pair at all', () => {
    for (const p of papers) {
      for (const q of papers) {
        const agreement = answerAgreement(p, q);
        if (agreement.matched !== 0) continue;
        expect(agreement.score).toBe(0);
        expect(shouldFlag(agreement, { threshold: 0.85, minCommon: 3 })).toBe(false);
      }
    }
  });

  test('every identical pair scores 1.0 — including the all-option-0 paper', () => {
    let missedByCosine = 0;

    for (const p of papers) {
      expect(answerAgreement(p, p).score).toBe(1);
      if (cosine(p, p) < 0.85) missedByCosine += 1;
    }

    // One paper — [0,0,0] — and it is the exact shape of a copied blank-looking answer key.
    expect(missedByCosine).toBe(1);
  });
});

describe('B9-④ — the scan marker replaces the 48-hour window', () => {
  const completedAt = new Date('2026-06-01T10:00:00Z');
  const firstScan   = new Date('2026-06-02T03:00:00Z');

  test('a never-scanned session is a candidate', () => {
    expect(shouldRescan({ completedAt, antiCheatScannedAt: null })).toBe(true);
  });

  test('the second nightly pass does NOT rescan — the double scan is gone', () => {
    // The defect in one assertion: a 48 h window read by a 24 h job selected every session
    // twice, and `$push` recorded every finding twice.
    expect(shouldRescan({ completedAt, antiCheatScannedAt: firstScan })).toBe(false);
  });

  test('a submission landing after the scan invalidates it', () => {
    expect(shouldRescan({
      antiCheatScannedAt: firstScan,
      lastSubmissionAt:   new Date('2026-06-02T09:00:00Z'),
    })).toBe(true);
  });

  test('a submission from before the scan does not', () => {
    expect(shouldRescan({
      antiCheatScannedAt: firstScan,
      lastSubmissionAt:   completedAt,
    })).toBe(false);
  });
});

describe('B9-⑦ — flags are collected, then written once', () => {
  const pairs = [{
    submissionA: 'subA', submissionB: 'subB',
    studentA: 'stuA', studentB: 'stuB',
    score: 0.95, common: 20,
  }];

  test('one flagged pair produces exactly two writes', () => {
    const ops = buildFlagWrites(pairs, { threshold: 0.85 });
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.filter).toEqual({ _id: 'subA' });
    expect(ops[1].updateOne.filter).toEqual({ _id: 'subB' });
  });

  test('each flag names the OTHER student', () => {
    const ops = buildFlagWrites(pairs, { threshold: 0.85 });
    expect(ops[0].updateOne.update.$push.antiCheatFlags.detail).toContain('stuB');
    expect(ops[1].updateOne.update.$push.antiCheatFlags.detail).toContain('stuA');
  });

  test('the flag shape still matches AntiCheatFlagSchema', () => {
    const flag = buildFlagWrites(pairs, { threshold: 0.85 })[0].updateOne.update.$push.antiCheatFlags;
    expect(Object.keys(flag).sort()).toEqual(['detail', 'timestamp', 'type']);
    expect(flag.type).toBe('SIMILARITY_FLAG');
    expect(flag.timestamp).toBeInstanceOf(Date);
  });

  test('the detail reports the sample size, not only the ratio', () => {
    // A 100% agreement on 6 questions and on 50 are different findings for a human
    // reviewer, and the old message carried neither number.
    const detail = buildFlagWrites(pairs, { threshold: 0.85 })[0].updateOne.update.$push.antiCheatFlags.detail;
    expect(detail).toContain('95.0%');
    expect(detail).toContain('20 commonly-answered');
  });

  test('no flagged pair produces no writes at all', () => {
    expect(buildFlagWrites([], { threshold: 0.85 })).toEqual([]);
  });
});
