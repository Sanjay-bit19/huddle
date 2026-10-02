import { expect, test } from '@playwright/test';
import { addCard, boardState, createBoard, signUp, snap } from './fixtures';

test('AI: notes become reviewed cards; summary streams with clickable citations', async ({
  browser,
}) => {
  const ada = await signUp(browser, 'Ada Lovelace');
  await createBoard(ada, 'AI board');
  const { page } = ada;

  await page.getByRole('button', { name: '✨ AI assist' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();

  // Notes -> proposals -> human review -> insert.
  await panel.getByRole('tab', { name: 'Notes → cards' }).click();
  await panel
    .getByLabel('Meeting notes')
    .fill(
      [
        'Planning sync',
        '- Draft the launch announcement @Ada #marketing by 2026-10-20',
        '- Fix the flaky login test #bug',
        '- Order team t-shirts',
        'We also talked about lunch.',
      ].join('\n'),
    );
  await panel.getByRole('button', { name: 'Propose cards' }).click();
  const proposals = panel.getByTestId('ai-proposals');
  await expect(proposals.getByLabel('Proposed card title')).toHaveCount(3);
  // Reject one and rename another before accepting.
  await proposals.getByLabel('Include Order team t-shirts').uncheck();
  await proposals.getByLabel('Proposed card title').nth(1).fill('Fix flaky login test (CI)');
  await snap(page, 'ai-notes-review');
  await proposals.getByRole('button', { name: 'Add 2 cards' }).click();
  await expect(panel.getByText('Added 2 cards to the board.')).toBeVisible();
  expect((await boardState(page))['To do']).toEqual([
    'Draft the launch announcement',
    'Fix flaky login test (CI)',
  ]);

  // Summary: streamed, grounded, citations open the card.
  await addCard(page, 'Done', 'Ship v1');
  await panel.getByRole('tab', { name: 'Summarize' }).click();
  await panel.getByRole('button', { name: 'Summarize this board' }).click();
  const output = panel.getByTestId('ai-summary-output');
  await expect(output).toContainText('Blockers');
  await expect(output.getByTestId('citation').first()).toBeVisible();
  await snap(page, 'ai-summary');
  await output.getByTestId('citation').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Budget meter reflects usage.
  await expect(panel.getByTestId('ai-budget')).toContainText('/ 200,000 tokens');

  await ada.context.close();
});
