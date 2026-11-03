import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

let seq = 0;
const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

export interface Session {
  context: BrowserContext;
  page: Page;
  name: string;
}

export async function signUp(browser: Browser, name: string): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/signup');
  await page.getByLabel('Name').fill(name);
  await page
    .getByLabel('Email')
    .fill(`${unique(name.toLowerCase().replace(/\W+/g, '-'))}@e2e.test`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByPlaceholder('New workspace name')).toBeVisible();
  return { context, page, name };
}

/** Creates a workspace + board as `owner`, returns the board URL. */
export async function createBoard(owner: Session, title = 'E2E board'): Promise<string> {
  const { page } = owner;
  await page.getByPlaceholder('New workspace name').fill(unique('Workspace'));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByPlaceholder('New board title').fill(title);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByTestId('column').first()).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-phase', 'connected');
  return page.url();
}

/** Owner creates an invite for `role` from the workspace page; returns the link. */
export async function createInvite(owner: Session, role: 'EDITOR' | 'VIEWER'): Promise<string> {
  const { page } = owner;
  const boardUrl = page.url();
  await page.getByRole('link', { name: /Workspace-/ }).click();
  await page.getByRole('tab', { name: 'invites' }).click();
  await page.getByLabel('Role').selectOption(role);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.goto(boardUrl);
  return link;
}

export async function joinViaInvite(member: Session, link: string, boardUrl: string) {
  await member.page.goto(link);
  await member.page.getByRole('button', { name: /Join as/ }).click();
  await expect(member.page.getByRole('tab', { name: 'boards' })).toBeVisible();
  await member.page.goto(boardUrl);
  await expect(member.page.getByTestId('column').first()).toBeVisible();
}

export function column(page: Page, title: string) {
  return page.locator(`[data-testid=column][data-column-title="${title}"]`);
}

export async function addCard(page: Page, columnTitle: string, title: string) {
  const col = column(page, columnTitle);
  const input = col.getByLabel('New card title');
  if (!(await input.isVisible())) await col.getByRole('button', { name: '+ Add card' }).click();
  await input.fill(title);
  await input.press('Enter');
}

/** Card titles per column, in display order. */
export async function boardState(page: Page): Promise<Record<string, string[]>> {
  return page.getByTestId('column').evaluateAll((cols) =>
    Object.fromEntries(
      cols.map((c) => [
        c.getAttribute('data-column-title'),
        [...c.querySelectorAll('[data-testid=card] [aria-label^="Card: "]')].map((el) =>
          el
            .getAttribute('aria-label')!
            .replace(/^Card: /, '')
            .replace(/\. Press Enter.*$/, ''),
        ),
      ]),
    ),
  );
}

/** True when both pages render exactly the same board. */
export async function converged(a: Page, b: Page): Promise<boolean> {
  const [x, y] = await Promise.all([boardState(a), boardState(b)]);
  return JSON.stringify(x) === JSON.stringify(y);
}

export async function dragCard(page: Page, cardTitle: string, toColumn: string) {
  const card = page.getByRole('button', { name: new RegExp(`^Card: ${cardTitle}\\.`) });
  const target = column(page, toColumn);
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 20, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 70, { steps: 12 });
  await page.mouse.up();
}

/** Saves a screenshot when E2E_SCREENSHOT_DIR is set (used for README images). */
export async function snap(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}
