import { test, expect, type Page } from '@playwright/test';
import {
  buildSshLab, waitForStore, openTerminal, typeCommand, sshHop, TARGETS,
} from './helpers/sshLab';

/**
 * Scénario (e2e) — la souris de vim. Un vim Debian/Ubuntu lit `defaults.vim` avec `mouse=` VIDE :
 * un clic ne déplace rien tant que `:set mouse=a` n'a pas été tapé. Une fois l'option posée, le clic
 * place le curseur sur la cellule cliquée (le moteur rend les cellules, le composant ne fait que
 * mesurer la grille), y compris sur une tabulation, et par un vrai saut SSH.
 */

async function clickCell(page: Page, row: number, column: number): Promise<void> {
  const body = await page.locator('[data-testid="vim-body"]').boundingBox();
  const cursor = await page.locator('[data-testid="vim-cursor"]').boundingBox();
  expect(body).not.toBeNull();
  expect(cursor).not.toBeNull();
  await page.mouse.click(body!.x + (column + 0.5) * cursor!.width, body!.y + (row + 0.5) * cursor!.height);
}

async function typeEx(page: Page, command: string): Promise<void> {
  await page.keyboard.press(':');
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test.describe('Scénario (e2e) — la souris de vim, en local et par SSH', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    const lab = await buildSshLab(page);
    await openTerminal(page, lab.linux1);
    await typeCommand(page, "printf 'alpha\\nbravo\\tcharlie\\ndelta\\n' > /tmp/mouse.txt");
    await page.waitForTimeout(400);
  });

  test('par défaut (mouse= vide) un clic ne déplace pas le curseur', async ({ page }) => {
    await typeCommand(page, 'vim /tmp/mouse.txt');
    await expect(page.locator('[data-testid="vim-body"]')).toBeVisible({ timeout: 8_000 });
    await clickCell(page, 2, 3);
    await expect(page.locator('[data-testid="vim-cursor"]')).toHaveText('a');
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('1,1');
  });

  test(':set mouse=a : le clic place le curseur sur la cellule cliquée, tabulation comprise', async ({ page }) => {
    await typeCommand(page, 'vim /tmp/mouse.txt');
    await expect(page.locator('[data-testid="vim-body"]')).toBeVisible({ timeout: 8_000 });
    await typeEx(page, 'set mouse=a');
    await clickCell(page, 2, 3);
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('3,4');
    await expect(page.locator('[data-testid="vim-cursor"]')).toHaveText('t');
    await clickCell(page, 1, 6);
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('2,6-8');
    await clickCell(page, 1, 8);
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('2,7-9');
    await clickCell(page, 1, 12);
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('2,11-13');
  });

  test('par SSH : le clic est envoyé au serveur, qui déplace le curseur de son éditeur', async ({ page }) => {
    await sshHop(page, `ssh user@${TARGETS.linux2.ip}`, 'admin');
    await typeCommand(page, "printf 'alpha\\nbravo\\tcharlie\\ndelta\\n' > /tmp/mouse-remote.txt");
    await page.waitForTimeout(400);
    await typeCommand(page, 'vim /tmp/mouse-remote.txt');
    await expect(page.locator('[data-testid="vim-body"]')).toBeVisible({ timeout: 10_000 });
    await typeEx(page, 'set mouse=a');
    await clickCell(page, 2, 3);
    await expect(page.locator('[data-testid="vim-cmdline"]')).toContainText('3,4', { timeout: 10_000 });
  });
});
