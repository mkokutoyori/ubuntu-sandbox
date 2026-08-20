import { test, expect, type Page } from '@playwright/test';

/**
 * La CLI d'un commutateur générique, dans le vrai terminal.
 *
 * `GenericSwitch` est non managé mais reçoit le shell Cisco en entier, et
 * ce shell lit des agents de protocole que seul `CiscoSwitch` construit.
 * Douze commandes levaient donc une exception — `vlan 10` comprise — et
 * une seule suffisait à coincer la session dans un mode sans issue.
 *
 * Équivalent e2e de `generic-switch-shell.test.ts`.
 */

const REFUSED = "% Invalid input detected at '^' marker.";

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
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
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

test.describe('CLI du commutateur générique', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'switch-generic'));
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
  });

  test('créer un VLAN marche, et une commande refusée ne coince pas la session', async ({ page }) => {
    // Refusée : cet équipement ne fait pas tourner VTP…
    await typeCmd(page, 'vtp mode transparent');
    expect(await modalText(page)).toContain(REFUSED);

    // …et la session continue normalement juste après.
    await typeCmd(page, 'vlan 10');
    await typeCmd(page, 'name LAB');
    // `exit` remonte d'un niveau. Tant que cet équipement recevait un
    // terminal BASH (son `getOSType()` répondait « generic », qui
    // retombait sur le défaut POSIX), `exit` DÉCONNECTAIT l'opérateur et
    // le terminal se fermait au milieu de la configuration.
    await typeCmd(page, 'exit');
    await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible();
    await typeCmd(page, 'end');
    await typeCmd(page, 'show vlan brief');

    const text = await modalText(page);
    expect(text).toContain('LAB');
  });

  test('`show interfaces switchport` répond, `show vtp status` refuse', async ({ page }) => {
    await typeCmd(page, 'interface eth0');
    await typeCmd(page, 'switchport mode trunk');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show interfaces eth0 switchport');
    const detail = await modalText(page);
    expect(detail).toContain('Administrative Mode: trunk');
    // Rien à négocier sans DTP — la vérité d'un port non managé.
    expect(detail).toContain('Negotiation of Trunking: Off');

    await typeCmd(page, 'show vtp status');
    expect(await modalText(page)).toContain(REFUSED);
  });
});
