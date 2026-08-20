import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 6 (e2e) — Édition de fichiers de configuration réseau
 * critiques (/etc/hosts, /etc/network/interfaces) et xxd, pilotée
 * depuis la vraie UI terminal.
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
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}
async function typeText(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.evaluate((c) => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true, cancelable: true }));
    }, ch);
  }
}
async function exCmd(page: Page, cmd: string): Promise<void> {
  await page.keyboard.press(':');
  await typeText(page, cmd);
  await page.keyboard.press('Enter');
}
function lastCommandOutput(transcript: string, command: string): string {
  return transcript.slice(transcript.lastIndexOf(command));
}

test.describe('Scénario 6 (e2e) — fichiers de configuration réseau', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('nano /etc/hosts: add entries, save, resolved via getent', async ({ page }) => {
    await typeCmd(page, 'cp /etc/hosts /tmp/hosts.bak');
    await typeCmd(page, 'nano /etc/hosts');
    await expect(page.getByText('GNU nano')).toBeVisible({ timeout: 5_000 });

    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown'); // clamps at the last line
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await typeText(page, '192.168.10.101\tpc-linux-1\tlinux1');
    await page.keyboard.press('Enter');
    await typeText(page, '192.168.10.102\tpc-linux-2\tlinux2');

    await page.keyboard.press('Control+o');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+x');

    await typeCmd(page, 'getent hosts pc-linux-2');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'getent hosts pc-linux-2');
    expect(out).toContain('192.168.10.102');
  });

  test('vim /etc/network/interfaces: create a static config, validated by ifup --no-act', async ({ page }) => {
    await typeCmd(page, 'vim /etc/network/interfaces');
    await expect(page.getByText('interfaces', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('i');
    await typeText(page, 'auto eth0');
    await page.keyboard.press('Enter');
    await typeText(page, 'iface eth0 inet static');
    await page.keyboard.press('Enter');
    await typeText(page, '    address 192.168.10.101');
    await page.keyboard.press('Enter');
    await typeText(page, '    netmask 255.255.255.0');
    await page.keyboard.press('Enter');
    await typeText(page, '    gateway 192.168.10.254');
    await page.keyboard.press('Escape');

    await exCmd(page, 'wq');

    await typeCmd(page, 'ifup --no-act eth0');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'ifup --no-act eth0');
    expect(out).not.toContain('could not read');
    expect(out).toContain('192.168.10.101');
  });

  test('xxd shows a byte-accurate hex dump of an edited file', async ({ page }) => {
    await typeCmd(page, 'echo "abc" > /tmp/xxd-e2e.txt');
    await typeCmd(page, 'xxd /tmp/xxd-e2e.txt');
    const transcript = await modalText(page);
    const out = lastCommandOutput(transcript, 'xxd /tmp/xxd-e2e.txt');
    expect(out).toContain('00000000: 6162 630a');
  });
});
