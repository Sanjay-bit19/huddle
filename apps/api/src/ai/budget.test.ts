import { describe, expect, it } from 'vitest';
import {
  decideReservation,
  estimatePromptTokens,
  periodKey,
  periodResetsAt,
  worstCaseTokens,
} from './budget';

describe('budget periods', () => {
  it('uses the UTC calendar month', () => {
    expect(periodKey(new Date('2026-10-02T10:00:00Z'))).toBe('2026-10');
    // 23:30 on Oct 31 in UTC-5 is already November in UTC.
    expect(periodKey(new Date('2026-10-31T23:30:00-05:00'))).toBe('2026-11');
  });

  it('resets at the start of the next month, across year boundaries', () => {
    expect(periodResetsAt(new Date('2026-10-15T00:00:00Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(periodResetsAt(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('estimates', () => {
  it('over-estimates prompt tokens (3 chars/token + overhead)', () => {
    expect(estimatePromptTokens('')).toBe(50);
    expect(estimatePromptTokens('a'.repeat(300))).toBe(150);
    expect(estimatePromptTokens('a'.repeat(150), 'b'.repeat(150))).toBe(150);
  });

  it('reserves the worst case for every attempt', () => {
    expect(worstCaseTokens(1000, 8000)).toBe(9000);
    expect(worstCaseTokens(1000, 8000, 2)).toBe(18000);
  });
});

describe('decideReservation', () => {
  const limit = 10_000;

  it('allows a request that fits', () => {
    expect(decideReservation({ used: 2000, reserved: 1000, limit }, 5000)).toEqual({
      ok: true,
      remainingAfter: 2000,
    });
  });

  it('counts in-flight reservations against the budget', () => {
    expect(decideReservation({ used: 2000, reserved: 6000, limit }, 5000)).toEqual({
      ok: false,
      reason: 'exhausted',
      remaining: 2000,
    });
  });

  it('allows a request that exactly fills the budget', () => {
    expect(decideReservation({ used: 5000, reserved: 0, limit }, 5000)).toEqual({
      ok: true,
      remainingAfter: 0,
    });
  });

  it('flags requests larger than the whole budget distinctly', () => {
    expect(decideReservation({ used: 0, reserved: 0, limit }, 10_001)).toEqual({
      ok: false,
      reason: 'request_too_large',
      remaining: 10_000,
    });
  });

  it('never reports negative remaining when over-spent', () => {
    // Actual usage can exceed the estimate (estimates are heuristics).
    expect(decideReservation({ used: 10_500, reserved: 0, limit }, 1)).toEqual({
      ok: false,
      reason: 'exhausted',
      remaining: 0,
    });
  });
});
