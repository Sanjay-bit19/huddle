import { describe, expect, it } from 'vitest';
import { extractJson, parseNotesToCards } from './parse';

const card = (over: Record<string, unknown> = {}) => ({
  title: 'Ship the beta',
  description: '',
  column: 'To do',
  labels: ['launch'],
  dueDate: '2026-11-01',
  assignees: ['Ada'],
  checklist: [],
  ...over,
});

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips markdown code fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('finds an object wrapped in prose', () => {
    expect(extractJson('Here you go:\n{"a": {"b": 2}}\nHope that helps')).toEqual({ a: { b: 2 } });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('parseNotesToCards', () => {
  it('accepts valid output', () => {
    const result = parseNotesToCards(JSON.stringify({ cards: [card()] }));
    expect(result).toEqual({ ok: true, data: { cards: [card()] } });
  });

  it('accepts an empty proposal list', () => {
    expect(parseNotesToCards('{"cards": []}')).toEqual({ ok: true, data: { cards: [] } });
  });

  it('rejects truncated JSON with a readable reason', () => {
    const result = parseNotesToCards('{"cards": [{"title": "x"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
  });

  it('reports field-level problems with their path (fed back to the model)', () => {
    const result = parseNotesToCards(
      JSON.stringify({ cards: [card({ title: '   ', dueDate: 'next friday', labels: 'urgent' })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cards.0.title');
      expect(result.error).toContain('cards.0.dueDate');
      expect(result.error).toContain('cards.0.labels');
    }
  });

  it('enforces limits the API schema cannot express', () => {
    const tooMany = { cards: Array.from({ length: 26 }, () => card()) };
    expect(parseNotesToCards(JSON.stringify(tooMany)).ok).toBe(false);
    const longTitle = { cards: [card({ title: 'x'.repeat(201) })] };
    expect(parseNotesToCards(JSON.stringify(longTitle)).ok).toBe(false);
    const manyLabels = { cards: [card({ labels: ['a', 'b', 'c', 'd', 'e', 'f'] })] };
    expect(parseNotesToCards(JSON.stringify(manyLabels)).ok).toBe(false);
  });

  it('rejects unexpected fields (strict schema)', () => {
    const result = parseNotesToCards(JSON.stringify({ cards: [card({ priority: 'high' })] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a missing top-level key', () => {
    expect(parseNotesToCards('{"items": []}').ok).toBe(false);
  });
});
