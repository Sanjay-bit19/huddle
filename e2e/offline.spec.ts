import { expect, test } from '@playwright/test';
import {
  addCard,
  boardState,
  converged,
  column,
  createBoard,
  createInvite,
  dragCard,
  joinViaInvite,
  signUp,
  snap,
} from './fixtures';

test('edits made offline sync and merge on reconnect', async ({ browser }) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  const boardUrl = await createBoard(ada, 'Offline');
  const link = await createInvite(ada, 'EDITOR');
  const bob = await signUp(browser, 'Bob Babbage');
  await joinViaInvite(bob, link, boardUrl);

  await addCard(ada.page, 'To do', 'Shared');
  await expect(bob.page.getByRole('button', { name: /^Card: Shared\./ })).toBeVisible();

  // Bob loses connectivity.
  await bob.context.setOffline(true);
  await expect(bob.page.getByTestId('connection-status')).toHaveAttribute('data-phase', 'offline');
  await expect(bob.page.getByTestId('offline-banner')).toBeVisible();

  // Bob keeps working offline...
  await addCard(bob.page, 'In progress', 'Written offline');
  await dragCard(bob.page, 'Shared', 'Done');
  await expect(column(bob.page, 'Done').getByTestId('card')).toHaveCount(1);
  await snap(bob.page, 'offline-editing');

  // ...while Ada, online, edits too. Neither sees the other's changes yet.
  await addCard(ada.page, 'To do', 'Written online');
  await ada.page.waitForTimeout(500);
  expect((await boardState(ada.page))['In progress']).toEqual([]);
  expect((await boardState(bob.page))['To do']).toEqual([]);

  // Back online: the provider reconnects and both sides merge.
  await bob.context.setOffline(false);
  await expect(bob.page.getByTestId('connection-status')).toHaveAttribute(
    'data-phase',
    'connected',
    {
      timeout: 20_000,
    },
  );
  // Both sides are re-read on every poll until they agree.
  await expect.poll(async () => converged(ada.page, bob.page), { timeout: 15_000 }).toBe(true);
  expect(await boardState(ada.page)).toEqual({
    'To do': ['Written online'],
    'In progress': ['Written offline'],
    Done: ['Shared'],
  });

  // And it is durable: a fresh load from the server shows the merged board.
  await ada.page.reload();
  await expect(ada.page.getByRole('button', { name: /^Card: Written offline\./ })).toBeVisible();

  await ada.context.close();
  await bob.context.close();
});
