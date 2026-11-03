import { and, eq, sql } from 'drizzle-orm';
import { aiUsage, type Database } from '@huddle/db';

/**
 * Monthly per-user token budget.
 *
 * Reserve-then-settle: before calling the model we atomically reserve the
 * request's worst case (estimated prompt tokens + max output tokens). The
 * reservation only succeeds if used + reserved + estimate fits the budget, in
 * a single conditional UPSERT, so N concurrent requests can never overspend
 * the remaining budget. Afterwards the reservation is released and the
 * provider-reported usage is charged.
 */

/** UTC calendar month, e.g. "2026-10". */
export function periodKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export function periodResetsAt(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/**
 * Conservative prompt-size estimate. Real tokenizers average ~4 chars/token
 * for English; using 3 over-reserves slightly, which errs on the safe side.
 */
export function estimatePromptTokens(...parts: string[]): number {
  const chars = parts.reduce((n, p) => n + p.length, 0);
  return Math.ceil(chars / 3) + 50;
}

export function worstCaseTokens(promptTokens: number, maxOutputTokens: number, attempts = 1) {
  return (promptTokens + maxOutputTokens) * attempts;
}

export interface BudgetSnapshot {
  used: number;
  reserved: number;
  limit: number;
}

export type BudgetDecision =
  | { ok: true; remainingAfter: number }
  | { ok: false; reason: 'exhausted' | 'request_too_large'; remaining: number };

export function decideReservation(snapshot: BudgetSnapshot, estimate: number): BudgetDecision {
  const remaining = Math.max(0, snapshot.limit - snapshot.used - snapshot.reserved);
  if (estimate > snapshot.limit) return { ok: false, reason: 'request_too_large', remaining };
  if (estimate > remaining) return { ok: false, reason: 'exhausted', remaining };
  return { ok: true, remainingAfter: remaining - estimate };
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly decision: Extract<BudgetDecision, { ok: false }>,
    public readonly resetsAt: Date,
  ) {
    super(
      decision.reason === 'request_too_large'
        ? 'This request is larger than your monthly AI budget'
        : 'Monthly AI token budget exhausted',
    );
  }
}

export interface Reservation {
  userId: string;
  period: string;
  amount: number;
}

export class BudgetStore {
  constructor(
    private readonly db: Database,
    private readonly limit: number,
  ) {}

  async snapshot(
    userId: string,
    period = periodKey(),
  ): Promise<BudgetSnapshot & { period: string }> {
    const [row] = await this.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), eq(aiUsage.period, period)));
    return {
      used: row?.tokensUsed ?? 0,
      reserved: row?.tokensReserved ?? 0,
      limit: this.limit,
      period,
    };
  }

  /** Atomically reserves `amount` tokens or throws BudgetExceededError. */
  async reserve(userId: string, amount: number, now = new Date()): Promise<Reservation> {
    const period = periodKey(now);
    if (amount > this.limit) {
      const snap = await this.snapshot(userId, period);
      const decision = decideReservation(snap, amount) as Extract<BudgetDecision, { ok: false }>;
      throw new BudgetExceededError(decision, periodResetsAt(now));
    }
    // Insert-or-update guarded by the budget check in ONE statement: Postgres
    // row-locks the existing row during ON CONFLICT DO UPDATE, so concurrent
    // reservations serialize and each sees the others' reservations.
    const rows = await this.db
      .insert(aiUsage)
      .values({ userId, period, tokensReserved: amount, requests: 1 })
      .onConflictDoUpdate({
        target: [aiUsage.userId, aiUsage.period],
        set: {
          tokensReserved: sql`${aiUsage.tokensReserved} + ${amount}`,
          requests: sql`${aiUsage.requests} + 1`,
          updatedAt: new Date(),
        },
        setWhere: sql`${aiUsage.tokensUsed} + ${aiUsage.tokensReserved} + ${amount} <= ${this.limit}`,
      })
      .returning({ period: aiUsage.period });
    if (rows.length === 0) {
      const snap = await this.snapshot(userId, period);
      const decision = decideReservation(snap, amount);
      throw new BudgetExceededError(
        decision.ok ? { ok: false, reason: 'exhausted', remaining: 0 } : decision,
        periodResetsAt(now),
      );
    }
    return { userId, period, amount };
  }

  /** Releases the reservation and charges what the provider actually reported. */
  async settle(reservation: Reservation, actualTokens: number): Promise<void> {
    await this.db
      .update(aiUsage)
      .set({
        tokensReserved: sql`greatest(${aiUsage.tokensReserved} - ${reservation.amount}, 0)`,
        tokensUsed: sql`${aiUsage.tokensUsed} + ${Math.max(0, Math.round(actualTokens))}`,
        updatedAt: new Date(),
      })
      .where(and(eq(aiUsage.userId, reservation.userId), eq(aiUsage.period, reservation.period)));
  }
}
