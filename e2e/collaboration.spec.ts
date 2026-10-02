import { expect, test } from '@playwright/test';
import {
  addCard,
  boardState,
  column,
  createBoard,
  createInvite,
  dragCard,
  joinViaInvite,
  signUp,
  snap,
} from './fixtures';

test('two people editing the same board concurrently converge to the same state', async ({
  browser,
}) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  const boardUrl = await createBoard(ada, 'Concurrency');
  const link = await createInvite(ada, 'EDITOR');
  const bob = await signUp(browser, 'Bob Babbage');
  await joinViaInvite(bob, link, boardUrl);

  // Presence: both see two people on the board.
  await expect(ada.page.getByTestId('presence-avatar')).toHaveCount(2);
  await expect(bob.page.getByTestId('presence-avatar')).toHaveCount(2);

  // Fire edits from both browsers at the same time.
  await Promise.all([
    (async () => {
      await addCard(ada.page, 'To do', 'Ada 1');
      await addCard(ada.page, 'To do', 'Ada 2');
      await addCard(ada.page, 'Done', 'Ada 3');
    })(),
    (async () => {
      await addCard(bob.page, 'To do', 'Bob 1');
      await addCard(bob.page, 'In progress', 'Bob 2');
    })(),
  ]);
  await expect(column(ada.page, 'To do').getByTestId('card')).toHaveCount(3);
  await expect(column(bob.page, 'To do').getByTestId('card')).toHaveCount(3);

  // Concurrent moves: Ada moves her card, Bob moves his, at the same time.
  await Promise.all([
    dragCard(ada.page, 'Ada 1', 'In progress'),
    dragCard(bob.page, 'Bob 1', 'Done'),
  ]);

  await expect
    .poll(async () => JSON.stringify(await boardState(ada.page)), { timeout: 10_000 })
    .toBe(JSON.stringify(await boardState(bob.page)));
  const final = await boardState(ada.page);
  expect(final['To do']).toEqual(['Ada 2']);
  expect([...final['In progress']!].sort()).toEqual(['Ada 1', 'Bob 2']);
  expect([...final['Done']!].sort()).toEqual(['Ada 3', 'Bob 1']);
  // Converged state matches on both sides, card for card, in order.
  expect(await boardState(bob.page)).toEqual(final);

  await ada.context.close();
  await bob.context.close();
});

test('presence: live cursors, editing indicators and merged concurrent typing', async ({
  browser,
}) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  const boardUrl = await createBoard(ada, 'Presence');
  const link = await createInvite(ada, 'EDITOR');
  const bob = await signUp(browser, 'Bob Babbage');
  await joinViaInvite(bob, link, boardUrl);
  await addCard(ada.page, 'To do', 'Shared card');
  await expect(bob.page.getByRole('button', { name: /^Card: Shared card\./ })).toBeVisible();

  // Ada's pointer shows up on Bob's screen.
  const canvas = ada.page.locator('[data-board-scroll]');
  const box = (await canvas.boundingBox())!;
  await ada.page.mouse.move(box.x + 600, box.y + 300, { steps: 5 });
  await expect(
    bob.page.getByTestId('live-cursor').filter({ hasText: 'Ada Lovelace' }),
  ).toBeVisible();
  await snap(bob.page, 'presence-live-cursor');

  // Ada opens the card: Bob sees "Ada editing" on it.
  await ada.page.getByRole('button', { name: /^Card: Shared card\./ }).click();
  await expect(bob.page.getByTestId('editing-indicator')).toHaveText(/Ada editing/);
  await snap(bob.page, 'presence-editing-indicator');

  // Both type into the description at once; the CRDT merges the keystrokes.
  await bob.page.getByRole('button', { name: /^Card: Shared card\./ }).click();
  await expect(bob.page.getByText(/Ada Lovelace is also editing this card/)).toBeVisible();
  const adaEditor = ada.page.getByTestId('description-editor');
  const bobEditor = bob.page.getByTestId('description-editor');
  await adaEditor.click();
  await bobEditor.click();
  await Promise.all([
    adaEditor.pressSequentially('alpha ', { delay: 20 }),
    bobEditor.pressSequentially('beta ', { delay: 20 }),
  ]);
  // Read the document text without the remote-caret name labels.
  const docText = (loc: typeof adaEditor) =>
    loc.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
      // Caret widgets also inject U+2060 word joiners around themselves.
      return clone.innerText.replace(/\u2060/g, '').trim();
    });
  await expect.poll(() => docText(adaEditor)).toBe(await docText(bobEditor));
  await snap(bob.page, 'concurrent-description-typing');
  const text = await docText(adaEditor);
  // One paragraph: both people typed into the same line.
  expect(text).not.toContain('\n');
  // YATA keeps each person's run of keystrokes contiguous: the merge is one
  // run after the other, with no lost, duplicated or interleaved characters.
  expect(['alpha beta', 'beta alpha']).toContain(text.replace(/\s+/g, ' ').trim());

  // Closing the card clears the indicator for others.
  await ada.page.getByRole('button', { name: 'Close' }).click();
  await bob.page.getByRole('button', { name: 'Close' }).click();
  await expect(bob.page.getByTestId('editing-indicator')).toHaveCount(0);

  await ada.context.close();
  await bob.context.close();
});

test('viewers receive live updates but cannot edit', async ({ browser }) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  const boardUrl = await createBoard(ada, 'Read only');
  const link = await createInvite(ada, 'VIEWER');
  const vic = await signUp(browser, 'Vic Viewer');
  await joinViaInvite(vic, link, boardUrl);

  await expect(vic.page.getByText('View only')).toBeVisible();
  await expect(vic.page.getByRole('button', { name: '+ Add card' })).toHaveCount(0);
  await expect(vic.page.getByLabel('New column title')).toHaveCount(0);

  await addCard(ada.page, 'To do', 'Visible to viewers');
  await expect(vic.page.getByRole('button', { name: /^Card: Visible to viewers\./ })).toBeVisible();

  await ada.context.close();
  await vic.context.close();
});
