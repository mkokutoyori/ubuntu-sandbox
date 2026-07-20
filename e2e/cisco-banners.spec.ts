import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 3 (e2e) — Bannières Cisco (MOTD, login, exec), pilotée depuis
 * la vraie UI terminal :
 *   - Capture interactive multi-lignes réelle de `banner motd #` (une
 *     ligne à la fois, comme un vrai opérateur taperait).
 *   - Ordre d'affichage réel sur la console : MOTD -> banner login ->
 *     User Access Verification -> Username:/Password: -> banner exec
 *     (uniquement après authentification réussie) -> prompt de commande.
 *   - `show running-config` affiche le délimiteur `^C...^C`.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addRouter(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice('router-cisco', 400, 250).id;
  });
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}
async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(200);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}
async function waitForText(page: Page, needle: string | RegExp, timeout = 6_000): Promise<void> {
  await expect.poll(async () => {
    const t = await modalText(page);
    return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
  }, { timeout }).toBe(true);
}
async function submitUsername(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function submitPassword(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

test.describe('Scénario 3 (e2e) — bannières Cisco', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("'banner motd #' seul ouvre une véritable capture multi-lignes, une ligne à la fois", async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd #');
    await typeCmd(page, 'AVERTISSEMENT SYSTEME PRIVE');
    await typeCmd(page, 'Acces non autorise interdit');
    await typeCmd(page, '#');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config');
    await waitForText(page, 'AVERTISSEMENT SYSTEME PRIVE');
    await waitForText(page, 'Acces non autorise interdit');
    await waitForText(page, '^C');
  });

  test("l'ordre MOTD -> banner login -> User Access Verification -> banner exec est respecté sur une reconnexion console", async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin privilege 15 secret Admin@2025');
    await typeCmd(page, 'banner motd #SYSTEME PRIVE MANDENG#');
    await typeCmd(page, 'banner login #AUTHENTIFICATION REQUISE#');
    await typeCmd(page, 'banner exec #BIENVENUE ACCES AUTORISE#');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'end');

    await closeTerminal(page);
    await openTerminal(page, id);

    await waitForText(page, 'SYSTEME PRIVE MANDENG');
    await waitForText(page, 'AUTHENTIFICATION REQUISE');
    await waitForText(page, 'User Access Verification');

    await submitUsername(page, 'admin');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'Admin@2025');

    await waitForText(page, 'BIENVENUE ACCES AUTORISE');
  });
});
