import { expect, test } from '@playwright/test';
import { addCard, boardState, createBoard, signUp } from './fixtures';

test('keyboard drag and drop moves cards across columns and announces each step', async ({
  browser,
}) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  await createBoard(ada, 'Keyboard board');
  const { page } = ada;
  await addCard(page, 'To do', 'alpha');
  await addCard(page, 'To do', 'beta');
  await page.keyboard.press('Escape');
  const card = page.getByRole('button', { name: /^Card: alpha\./ });
  const live = page.locator('[id^="DndLiveRegion"]');
  const columns = async () => {
    const s = await boardState(page);
    return [s['To do'], s['In progress'], s['Done']];
  };

  // Space lifts, ArrowRight jumps one column (one press), Space drops.
  await card.focus();
  await page.keyboard.press('Space');
  // "Picked up card "alpha"." is immediately followed by where it is over.
  await expect(live).toContainText('card "alpha" is over position 1 of 2 in To do');
  await page.keyboard.press('ArrowRight');
  await expect(live).toContainText('in In progress');
  await page.keyboard.press('Space');
  await expect(live).toContainText('Dropped card "alpha"');
  await expect.poll(columns).toEqual([['beta'], ['alpha'], []]);

  // ArrowLeft moves back.
  await card.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await expect(live).toContainText('in To do');
  await page.keyboard.press('Space');
  await expect.poll(async () => (await columns())[1]).toEqual([]);
  expect((await columns())[0]).toContain('alpha');

  // Escape cancels a move.
  await card.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(live).toContainText('Cancelled');
  expect((await columns())[1]).toEqual([]);

  await ada.context.close();
});
