import { test, expect, type Page } from '@playwright/test';
import { nanoRows, nanoCursor } from './helpers/nanoScreen';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, sshHop, TARGETS,
} from './helpers/sshLab';

/**
 * Scénario (e2e) — la fenêtre de l'éditeur suit la taille réelle du terminal, en local et par
 * SSH : redimensionner le navigateur change le nombre de rangées que le moteur dessine
 * (window-change côté SSH, RFC 4254 §6.7), le curseur reste sur une rangée visible, et une
 * tabulation place le curseur à la colonne du taquet suivant, comme le vrai éditeur.
 */

async function vimRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid="vim-body"] > div').count();
}

async function nanoEditRowCount(page: Page): Promise<number> {
  return (await nanoRows(page)).length;
}

async function shrinkViewport(page: Page): Promise<void> {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: Math.floor(size.height * 0.6) });
  await page.waitForTimeout(600);
}

test.describe('Scénario (e2e) — redimensionnement des éditeurs, en local et par SSH', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await typeCommand(page, 'for i in $(seq 1 100); do echo "line $i" >> /tmp/resize.txt; done');
    await page.waitForTimeout(500);
  });

  test('nano local : réduire la fenêtre réduit la fenêtre d\'édition et garde le curseur visible', async ({ page }) => {
    await typeCommand(page, 'nano /tmp/resize.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 8_000 });
    const before = await nanoEditRowCount(page);

    await page.keyboard.press('Control+_');
    await page.keyboard.type('50');
    await page.keyboard.press('Enter');
    await shrinkViewport(page);

    const after = await nanoEditRowCount(page);
    expect(after).toBeLessThan(before);
    const cursor = await nanoCursor(page);
    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(after);
    expect(await page.locator('[data-testid="nano-cursor"]').textContent()).toBe('l');
  });

  test('vim local : réduire la fenêtre réduit la fenêtre d\'édition et garde le curseur visible', async ({ page }) => {
    await typeCommand(page, 'vim /tmp/resize.txt');
    await expect(page.locator('[data-testid="vim-body"]')).toBeVisible({ timeout: 8_000 });
    const before = await vimRowCount(page);

    await page.keyboard.type('50G');
    await shrinkViewport(page);

    const after = await vimRowCount(page);
    expect(after).toBeLessThan(before);
    await expect(page.locator('[data-testid="vim-cursor"]')).toBeVisible();
    await expect(page.locator('[data-testid="vim-body"]')).toContainText('line 50');
  });

  test('nano par SSH : le window-change redessine la fenêtre à la nouvelle taille', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, 'for i in $(seq 1 100); do echo "line $i" >> /tmp/resize-remote.txt; done');
    await page.waitForTimeout(500);
    await typeCommand(page, 'nano /tmp/resize-remote.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 10_000 });
    const before = await nanoEditRowCount(page);

    await shrinkViewport(page);
    await expect.poll(() => nanoEditRowCount(page), { timeout: 10_000 }).toBeLessThan(before);
    await expect(page.locator('[data-testid="nano-cursor"]')).toBeVisible();
  });

  test('vim par SSH : le window-change redessine la fenêtre à la nouvelle taille', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, 'for i in $(seq 1 100); do echo "line $i" >> /tmp/resize-remote2.txt; done');
    await page.waitForTimeout(500);
    await typeCommand(page, 'vim /tmp/resize-remote2.txt');
    await expect(page.locator('[data-testid="vim-body"]')).toBeVisible({ timeout: 10_000 });
    const before = await vimRowCount(page);

    await shrinkViewport(page);
    await expect.poll(() => vimRowCount(page), { timeout: 10_000 }).toBeLessThan(before);
    await expect(page.locator('[data-testid="vim-cursor"]')).toBeVisible();
  });

  test('nano par SSH : la tabulation place le curseur au taquet suivant', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, "printf 'a\\tb\\n' > /tmp/tab-remote.txt");
    await page.waitForTimeout(500);
    await typeCommand(page, 'nano /tmp/tab-remote.txt');
    await expect(page.locator('[data-testid="nano-body"]')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => nanoCursor(page)).toEqual({ row: 1, column: 8 });
    await expect(page.locator('[data-testid="nano-cursor"]')).toHaveText('b');
  });
});
