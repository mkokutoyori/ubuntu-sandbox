import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x = 400, y = 300): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
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

async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function becomeRoot(page: Page): Promise<void> {
  await typeCmd(page, 'sudo su -');
  await typePassword(page, 'admin');
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 8_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 5 — iptables/nftables persistance et trafic (UI réelle)', () => {
  test('une règle ajoutée en runtime sans sauvegarde disparaît après un redémarrage', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-server');
    await openTerminal(page, pcId);

    await typeCmd(page, 'iptables -A INPUT -p tcp --dport 1000 -j ACCEPT');
    await typeCmd(page, 'netfilter-persistent save');
    await typeCmd(page, 'iptables -A INPUT -p tcp --dport 9999 -j DROP');
    await typeCmd(page, 'iptables -S INPUT');
    await waitForText(page, '9999');

    await typeCmd(page, 'reboot');
    await typeCmd(page, 'iptables -S INPUT');
    await waitForText(page, '1000');

    const finalText = await modalText(page);
    const postRebootOutput = finalText.split('iptables -S INPUT').pop() ?? '';
    expect(postRebootOutput).toContain('1000');
    expect(postRebootOutput).not.toContain('9999');
  });

  test('nft list ruleset reflète les règles actives et diverge du fichier tant que non sauvegardé', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-server');
    await openTerminal(page, pcId);

    await typeCmd(page, 'iptables -A INPUT -p tcp --dport 8080 -j ACCEPT');
    await typeCmd(page, 'nft list ruleset');
    await waitForText(page, 'table ip filter');
    await waitForText(page, 'tcp dport 8080');

    await typeCmd(page, 'nft list ruleset > /etc/nftables.conf');
    await typeCmd(page, 'iptables -A INPUT -p tcp --dport 5000 -j ACCEPT');
    await typeCmd(page, 'nft list ruleset');
    await waitForText(page, '5000');
    await typeCmd(page, 'cat /etc/nftables.conf');
    const finalText = await modalText(page);
    const savedFileOutput = finalText.split('cat /etc/nftables.conf').pop() ?? '';
    expect(savedFileOutput).toContain('8080');
    expect(savedFileOutput).not.toContain('5000');
  });
});
