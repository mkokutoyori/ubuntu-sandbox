import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 1 (e2e) — Authentification locale et niveaux de privilège
 * Cisco, pilotée depuis la vraie UI terminal : bannière "User Access
 * Verification", prompt Username:/Password:, niveau de privilège réel
 * après authentification, prompt "Password:" de "enable", et refus
 * d'une commande hors du niveau courant.
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
  // The password input is visually hidden (the "Password: " <span> sits on
  // top of it) -- .focus() instead of .click(), matching the established
  // pattern from every other password-prompt e2e spec in this repo.
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

test.describe('Scénario 1 (e2e) — authentification locale et niveaux de privilège', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("une nouvelle connexion console affiche User Access Verification / Username: / Password:, et un compte niveau 15 ouvre au prompt #", async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin privilege 15 secret Admin@2025');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'hostname R-MANDENG');
    await typeCmd(page, 'end');

    await closeTerminal(page);
    await openTerminal(page, id);

    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'admin');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'Admin@2025');

    await waitForText(page, 'R-MANDENG#');
    await typeCmd(page, 'show privilege');
    await waitForText(page, 'Current privilege level is 15');
  });

  test('un mauvais mot de passe 3 fois de suite affiche % Login invalid puis % Bad passwords et ferme le terminal', async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username admin privilege 15 secret Admin@2025');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'end');

    await closeTerminal(page);
    await openTerminal(page, id);
    await waitForText(page, 'User Access Verification');

    // First two failed attempts: the flow re-prompts "Username:" after
    // each one, which is a real suspend point (waiting on user input) --
    // so "% Login invalid" is reliably observable in the DOM before the
    // next prompt appears.
    for (let i = 0; i < 2; i++) {
      await submitUsername(page, 'admin');
      await waitForText(page, 'Password:');
      await submitPassword(page, 'WrongPassword');
      await waitForText(page, '% Login invalid');
    }

    // Third failed attempt: "% Login invalid" -> "% Bad passwords" -> the
    // line closes, all driven synchronously with no further prompt to
    // suspend on -- so the only reliably UI-observable outcome is the
    // terminal actually closing (matches real IOS: the line drops after
    // 3 bad passwords).
    await submitUsername(page, 'admin');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'WrongPassword');
    await expect(page.locator('[data-testid="terminal-modal"]')).not.toBeVisible({ timeout: 5_000 });
  });

  test('"enable" affiche un vrai prompt Password: et une commande hors niveau est refusée exactement comme une commande inconnue', async ({ page }) => {
    const id = await addRouter(page);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'enable secret Enable@2025');
    await typeCmd(page, 'username operateur privilege 7 secret Oper@2025');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'end');

    await closeTerminal(page);
    await openTerminal(page, id);
    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'operateur');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'Oper@2025');

    await typeCmd(page, 'show privilege');
    await waitForText(page, 'Current privilege level is 7');

    // A privileged-only command at level 7 is refused exactly like an
    // unknown command -- no distinct "permission denied" leak.
    await typeCmd(page, 'show running-config');
    await waitForText(page, "% Invalid input detected at '^' marker.");

    // Elevating with the real enable secret produces a real Password:
    // prompt and genuinely escalates to 15.
    await typeCmd(page, 'enable 15');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'Enable@2025');
    await typeCmd(page, 'show privilege');
    await waitForText(page, 'Current privilege level is 15');
  });
});
