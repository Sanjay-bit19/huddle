import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addCard, addChecklistItem, boardRoots, cardDescription, readBoard } from './model';
import { createSeedUpdate } from './seed';
import { validateBoardUpdate, MAX_UPDATE_BYTES } from './validate-update';

function capture(doc: Y.Doc, fn: () => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const handler = (u: Uint8Array) => updates.push(u);
  doc.on('update', handler);
  fn();
  doc.off('update', handler);
  return Y.mergeUpdates(updates);
}

function seeded() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createSeedUpdate('b'));
  return { doc, col: readBoard(doc).columns[0]!.id };
}

describe('validateBoardUpdate', () => {
  it('accepts every update the board model produces', () => {
    const { doc, col } = seeded();
    expect(validateBoardUpdate(createSeedUpdate('b'))).toEqual({ ok: true });
    const u1 = capture(doc, () => {
      const id = addCard(doc, {
        columnId: col,
        title: 'Card',
        description: 'Some text\nmore',
        labels: ['bug'],
        assignees: ['5f7c1c9e-0000-4000-8000-000000000000'],
        dueDate: '2026-11-01',
        checklist: ['one', 'two'],
      });
      addChecklistItem(doc, id, 'three');
    });
    expect(validateBoardUpdate(u1)).toEqual({ ok: true });
  });

  it('accepts rich-text node attributes (e.g. heading level)', () => {
    const { doc, col } = seeded();
    const id = addCard(doc, { columnId: col, title: 'x' });
    const u = capture(doc, () => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', '2' as unknown as string);
      cardDescription(doc, id)!.insert(0, [h]);
    });
    expect(validateBoardUpdate(u)).toEqual({ ok: true });
  });

  it('rejects oversized titles', () => {
    const { doc, col } = seeded();
    const u = capture(doc, () => {
      const id = addCard(doc, { columnId: col, title: 'ok' });
      boardRoots(doc).cards.get(id)!.set('title', 'x'.repeat(10_000));
    });
    expect(validateBoardUpdate(u, doc)).toMatchObject({ ok: false });
  });

  it('rejects a malformed card position', () => {
    const { doc } = seeded();
    const u = capture(doc, () => {
      const card = new Y.Map<unknown>();
      boardRoots(doc).cards.set('evil', card);
      card.set('pos', { columnId: 42, order: null });
    });
    expect(validateBoardUpdate(u)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pos'),
    });
  });

  it('rejects bad due dates', () => {
    const { doc, col } = seeded();
    const u = capture(doc, () => {
      const id = addCard(doc, { columnId: col, title: 'x' });
      boardRoots(doc).cards.get(id)!.set('dueDate', 'tomorrow-ish');
    });
    expect(validateBoardUpdate(u, doc)).toMatchObject({ ok: false });
  });

  it('rejects binary content and subdocuments', () => {
    const { doc } = seeded();
    const u = capture(doc, () => {
      boardRoots(doc).meta.set('blob', new Uint8Array(10));
    });
    expect(validateBoardUpdate(u)).toMatchObject({ ok: false });
    const u2 = capture(doc, () => {
      boardRoots(doc).meta.set('sub', new Y.Doc());
    });
    expect(validateBoardUpdate(u2)).toMatchObject({ ok: false });
  });

  it('rejects arbitrary objects under unknown keys', () => {
    const { doc } = seeded();
    const u = capture(doc, () => {
      boardRoots(doc).meta.set('payload', { huge: 'x'.repeat(5000) });
    });
    expect(validateBoardUpdate(u)).toMatchObject({ ok: false });
  });

  it('resolves overwritten keys against the live document', () => {
    const { doc, col } = seeded();
    const id = addCard(doc, { columnId: col, title: 'ok' });
    // A separate update that only overwrites the title: parentSub is not
    // encoded, so the validator must look the previous value up in the doc.
    const u = capture(doc, () => boardRoots(doc).cards.get(id)!.set('title', 'y'.repeat(600)));
    expect(validateBoardUpdate(u, doc)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('title'),
    });
    const fine = capture(doc, () => boardRoots(doc).cards.get(id)!.set('title', 'short'));
    expect(validateBoardUpdate(fine, doc)).toEqual({ ok: true });
    // Without the doc the key is unresolvable and strings over 256 chars are refused.
    expect(validateBoardUpdate(u)).toMatchObject({ ok: false });
  });

  it('rejects garbage bytes and oversized updates', () => {
    expect(validateBoardUpdate(new Uint8Array([255, 255, 255, 1, 2, 3]))).toMatchObject({
      ok: false,
    });
    expect(validateBoardUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('too large'),
    });
  });
});
