import { expect, test } from '@playwright/test';
import { addCard, createBoard, createInvite, joinViaInvite, signUp, snap } from './fixtures';

test('comments, activity feed and workspace search', async ({ browser }) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  const boardUrl = await createBoard(ada, 'Features');
  const link = await createInvite(ada, 'EDITOR');
  const bob = await signUp(browser, 'Bob Babbage');
  await joinViaInvite(bob, link, boardUrl);
  const { page } = ada;

  await addCard(page, 'To do', 'Database migration');
  await addCard(page, 'To do', 'Marketing site');

  // Comments appear live for the other person viewing the same card.
  await page.getByRole('button', { name: /^Card: Database migration\./ }).click();
  await bob.page.getByRole('button', { name: /^Card: Database migration\./ }).click();
  await page.getByLabel('Write a comment').fill('Needs a rollback plan');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(bob.page.getByTestId('comments')).toContainText('Needs a rollback plan');
  await snap(bob.page, 'card-comments');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await bob.page.getByRole('button', { name: 'Close', exact: true }).click();

  // Activity feed, attributed and live.
  await bob.page.getByRole('button', { name: 'Activity' }).click();
  const feed = bob.page.getByTestId('activity-list');
  await expect(feed).toContainText('Ada Lovelace added "Database migration" to To do');
  await expect(feed).toContainText('commented on "Database migration"');
  await addCard(page, 'Done', 'Retro notes');
  await expect(feed).toContainText('added "Retro notes" to Done');

  // Search: prefix match across the workspace, result deep-links to the card.
  // The index is a read model refreshed on compaction, so allow a few seconds.
  const search = page.getByLabel('Search cards in this workspace');
  const prefixes = ['mig', 'migr', 'migra', 'migrat', 'migrati', 'migratio', 'migration'];
  let attempt = 0;
  await expect(async () => {
    // A different prefix each time, so every retry is a fresh query.
    await search.fill(prefixes[attempt++ % prefixes.length]!);
    await expect(page.getByTestId('search-results')).toContainText('Database migration', {
      timeout: 2000,
    });
  }).toPass({ timeout: 25_000 });
  await snap(page, 'search');
  await page.getByTestId('search-results').getByRole('button').first().click();
  await expect(page).toHaveURL(/\?card=/);
  await expect(page.getByRole('dialog', { name: 'Database migration' })).toBeVisible();

  await ada.context.close();
  await bob.context.close();
});
