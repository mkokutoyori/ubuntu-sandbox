import { test, expect } from '@playwright/test';
import { addDevice, lastLines, openTerminal, typeCmd, waitForStore } from './helpers/terminalLab';

test.describe('less dans le terminal', () => {
  test('pagine un fichier, cherche, numérote et rend le shell en quittant', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, `sh -c 'seq 1 200 | sed "s/.*/ligne &/" > /tmp/big.txt'`);
    await typeCmd(page, 'less /tmp/big.txt');
    const body = page.locator('[data-testid="less-body"]');
    await expect(body).toBeVisible();
    await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('ligne 1');
    await expect(page.locator('[data-testid="less-status"]')).toHaveText('/tmp/big.txt');

    await page.keyboard.press('Space');
    const afterPage = await page.locator('[data-testid="less-line"]').first().innerText();
    expect(Number(/ligne (\d+)/.exec(afterPage)?.[1])).toBeGreaterThan(5);
    await expect(page.locator('[data-testid="less-status"]')).toHaveText(':');

    await page.keyboard.type('/ligne 150');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('ligne 150');

    await page.keyboard.type('-N');
    await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('    150 ligne 150');

    await page.keyboard.press('G');
    await expect(page.locator('[data-testid="less-status"]')).toHaveText('(END)');

    await page.keyboard.type('/introuvable');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="less-status"]')).toHaveText('Pattern not found: introuvable (press RETURN)');

    await page.keyboard.press('q');
    await expect(body).toHaveCount(0);
    await typeCmd(page, 'echo retour-shell');
    expect(await lastLines(page, 4)).toContain('retour-shell');
  });

  test('cmd | less ouvre le pager sur la sortie, et sans terminal less agit comme cat', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, 'seq 1 80 | less');
    await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('1');
    await expect(page.locator('[data-testid="less-status"]')).toHaveText(':');
    await page.keyboard.type('h');
    await expect(page.locator('[data-testid="less-body"]')).toContainText('SUMMARY OF LESS COMMANDS');
    await page.keyboard.press('q');
    await expect(page.locator('[data-testid="less-line"]').first()).toHaveText('1');
    await page.keyboard.press('q');

    await typeCmd(page, 'less --help');
    await expect(page.locator('[data-testid="less-body"]')).toContainText('SUMMARY OF LESS COMMANDS');
    await page.keyboard.press('q');
    await expect(page.locator('[data-testid="less-body"]')).toHaveCount(0);
    await typeCmd(page, 'less -V');
    expect(await lastLines(page, 9)).toContain('less 590');

    await typeCmd(page, 'printf "a\\nb\\n" > /tmp/s.txt');
    await typeCmd(page, 'less /tmp/s.txt > /tmp/o.txt; cat /tmp/o.txt');
    expect(await lastLines(page, 5)).toContain('a\nb');
    await typeCmd(page, 'less /tmp/inexistant');
    expect(await lastLines(page, 3)).toContain('/tmp/inexistant: No such file or directory');
  });
});
