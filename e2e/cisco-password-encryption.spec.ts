import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 4 (e2e) — service password-encryption et sécurisation des
 * mots de passe, pilotée depuis la vraie UI terminal :
 *   - `username X password Y` affiche `password 0 Y` (chiffre explicite)
 *     alors que `enable password Y` n'affiche AUCUN chiffre pour le type 0.
 *   - L'avertissement de dépréciation type 0 apparaît directement dans le
 *     terminal après `username X password Y`.
 *   - `service password-encryption` ré-encode rétroactivement un mot de
 *     passe déjà configuré, visible dans `show running-config`.
 *   - `show running-config | include password|secret|username`
 *     (alternance multi-motifs) fonctionne depuis le vrai terminal.
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
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
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

test.describe('Scénario 4 (e2e) — service password-encryption', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("username password affiche le chiffre 0 explicitement ; enable password ne l'affiche jamais pour le type 0", async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin password ClearText123');
    await waitForText(page, 'WARNING: Command has been added to the configuration using a type 0');

    await typeCmd(page, 'enable password EnableClear');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config');
    await waitForText(page, 'password 0 ClearText123');
    await waitForText(page, 'enable password EnableClear');
    const text = await modalText(page);
    expect(text).not.toContain('enable password 0 EnableClear');
  });

  test('service password-encryption ré-encode rétroactivement les mots de passe déjà configurés', async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin password ClearText123');
    await typeCmd(page, 'enable password EnableClear');
    await typeCmd(page, 'service password-encryption');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config | include password|secret|username');
    await waitForText(page, /password 7 [0-9A-F]+/);
    await waitForText(page, 'username admin');
    // Scope the "no cleartext" check to the `show running-config` output
    // specifically -- the scrollback legitimately still shows the
    // cleartext as originally TYPED (real terminal echo, same as any
    // real Cisco console); what must never leak in cleartext is the
    // stored/rendered CONFIG itself.
    const text = await modalText(page);
    const configOutput = text.slice(text.lastIndexOf('show running-config'));
    expect(configOutput).not.toContain('ClearText123');
    expect(configOutput).not.toContain('EnableClear');
  });
});
