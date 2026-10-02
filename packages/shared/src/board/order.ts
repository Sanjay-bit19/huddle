import { generateKeyBetween } from 'fractional-indexing';

/**
 * Ordering with fractional indexes.
 *
 * Every column and card carries an `order` string that sorts lexically. To
 * move something we write ONE new key between its new neighbours; nothing
 * else is touched. A Y.Array would model a move as delete + insert, and two
 * people moving the same card concurrently would then duplicate it.
 *
 * Two clients inserting between the same neighbours at the same time can mint
 * the same key; ties are broken by id so every replica sorts identically.
 */

export interface Ordered {
  id: string;
  order: string;
}

export function compareOrdered(a: Ordered, b: Ordered): number {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortOrdered<T extends Ordered>(items: readonly T[]): T[] {
  return [...items].sort(compareOrdered);
}

/**
 * Returns an order key that places an item at `index` within `siblings`
 * (already sorted, and NOT containing the item being placed).
 */
export function orderKeyAt(siblings: readonly Ordered[], index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = i > 0 ? siblings[i - 1]!.order : null;
  let after: string | null = null;
  // Skip neighbours that tie with `before` (possible after concurrent
  // inserts): a key strictly between equal keys does not exist.
  for (let j = i; j < siblings.length; j++) {
    const candidate = siblings[j]!.order;
    if (before === null || candidate > before) {
      after = candidate;
      break;
    }
  }
  return generateKeyBetween(before, after);
}

export const firstOrderKey = (): string => generateKeyBetween(null, null);
