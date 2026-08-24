import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function poser(page: Page, type: string): Promise<string> {
  return page.evaluate((kind) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice(kind, 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  }, type);
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(150);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(
    async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

const LISTE = [
  'access-list 10 remark Autoriser le LAN admin',
  'access-list 10 permit 192.168.20.0 0.0.0.255',
  'access-list 10 remark Refuser le reste',
  'access-list 10 deny any',
];

test.describe('Cisco — remarque sur une ACL numerotee', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await waitForStore(page);
  });

  test('le routeur accepte la remarque et la rend dans sa configuration',
    async ({ page }) => {
      const id = await poser(page, 'router-cisco');
      await openTerminal(page, id);

      for (const ligne of [
        'enable', 'configure terminal', ...LISTE, 'end',
        'show running-config | include access-list',
      ]) await typeCmd(page, ligne);

      await waitForText(page, 'access-list 10 remark Autoriser le LAN admin');
      await waitForText(page, 'access-list 10 remark Refuser le reste');
    });

  test('la remarque ne consomme aucun numero de sequence', async ({ page }) => {
    const id = await poser(page, 'router-cisco');
    await openTerminal(page, id);

    for (const ligne of [
      'enable', 'configure terminal', ...LISTE, 'end', 'show access-lists 10',
    ]) await typeCmd(page, ligne);

    await waitForText(page, '10 permit 192.168.20.0');
    await waitForText(page, '20 deny');
  });

  test('le commutateur l accepte aussi', async ({ page }) => {
    const id = await poser(page, 'switch-cisco');
    await openTerminal(page, id);

    for (const ligne of [
      'enable', 'configure terminal', ...LISTE, 'end',
      'show running-config | include access-list',
    ]) await typeCmd(page, ligne);

    await waitForText(page, 'access-list 10 remark Autoriser le LAN admin');
  });
});
