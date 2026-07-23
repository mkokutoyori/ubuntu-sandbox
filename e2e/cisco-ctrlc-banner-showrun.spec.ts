import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 9 (e2e) — délimiteur ^C dans show running-config, depuis le
 * terminal UI d'un routeur Cisco : la bannière saisie avec un délimiteur
 * quelconque ($) est TOUJOURS réaffichée avec ^C par show run, et la
 * sortie de show run se re-colle telle quelle (délimiteur visuel ^C
 * accepté) pour reproduire la même bannière.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText());
}

test.describe('Scénario 9 (e2e) — bannière Cisco et délimiteur ^C dans show run', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);
  });

  test('bannière saisie avec $ → show run affiche banner motd ^C, jamais le $', async ({ page }) => {
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd $');
    await typeCmd(page, 'Bienvenue sur SW-MANDENG-01');
    await typeCmd(page, '$');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config | section banner motd');

    const text = await modalText(page);
    expect(text).toContain('banner motd ^C');
    expect(text).toContain('Bienvenue sur SW-MANDENG-01');
    expect(text).not.toContain('banner motd $');
  });

  test('re-coller la sortie show run (délimiteur visuel ^C) reproduit la même bannière', async ({ page }) => {
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    // Re-collage tel qu'affiché par show run : ^C = deux caractères visuels.
    await typeCmd(page, 'banner motd ^C');
    await typeCmd(page, 'Acces reserve au personnel autorise');
    await typeCmd(page, '^C');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config | section banner motd');

    const text = await modalText(page);
    expect(text).toContain('banner motd ^C');
    expect(text).toContain('Acces reserve au personnel autorise');
  });

  test('la bannière est réellement affichée à l\'entrée en session (pas seulement stockée)', async ({ page }) => {
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'banner motd $');
    await typeCmd(page, 'Reseau MANDENG - acces controle');
    await typeCmd(page, '$');
    await typeCmd(page, 'end');
    // `exit` depuis le mode privilégié ferme la session ; la bannière MOTD
    // doit précéder le prompt à la reconnexion.
    await typeCmd(page, 'exit');
    await page.waitForTimeout(400);
    const text = await modalText(page);
    expect(text).toContain('Reseau MANDENG - acces controle');
  });
});
