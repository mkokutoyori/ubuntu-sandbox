/**
 * Scénario 2 — Ordre de résolution (nsswitch.conf) et /etc/resolv.conf,
 * driven through the real terminal UI on two devices: a Linux PC and a
 * Linux server running dnsmasq as the authoritative DNS for the LAN.
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function setupLab(page: Page): Promise<{ pcId: string; dnsId: string }> {
  return page.evaluate(() => {
    type StoreState = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const pc = store.getState().addDevice('linux-pc', 200, 300);
    const dns = store.getState().addDevice('linux-server', 500, 300);
    store.getState().addConnection(pc.id, 'eth0', dns.id, 'eth0', 'ethernet');
    return { pcId: pc.id, dnsId: dns.id };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').first().click({ timeout: 5_000 });
  await page.waitForTimeout(300);
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

test.describe('Scénario 2 — nsswitch.conf / resolv.conf (UI réelle)', () => {
  test('getent respecte nsswitch (files) tandis que nslookup interroge directement le DNS', async ({ page }) => {
    const { pcId, dnsId } = await setupLab(page);

    await openTerminal(page, dnsId);
    await typeCmd(page, 'ip addr add 10.0.1.10/24 dev eth0');
    await typeCmd(page, "printf 'address=/serveur.domaine.local/10.0.1.88\\n' > /etc/dnsmasq.conf");
    await typeCmd(page, 'dnsmasq');
    await closeTerminal(page);

    await openTerminal(page, pcId);
    await becomeRoot(page);
    await typeCmd(page, 'ip addr add 10.0.1.2/24 dev eth0');
    await typeCmd(page, "printf 'nameserver 10.0.1.10\\n' > /etc/resolv.conf");
    await typeCmd(page, "printf '10.0.1.99 serveur.domaine.local\\n' >> /etc/hosts");

    await typeCmd(page, 'getent hosts serveur.domaine.local');
    await waitForText(page, '10.0.1.99');

    await typeCmd(page, 'nslookup serveur.domaine.local');
    await waitForText(page, '10.0.1.88');
  });

  test('changer nsswitch.conf en "dns files" fait basculer getent immédiatement', async ({ page }) => {
    const { pcId, dnsId } = await setupLab(page);

    await openTerminal(page, dnsId);
    await typeCmd(page, 'ip addr add 10.0.1.10/24 dev eth0');
    await typeCmd(page, "printf 'address=/serveur.domaine.local/10.0.1.88\\n' > /etc/dnsmasq.conf");
    await typeCmd(page, 'dnsmasq');
    await closeTerminal(page);

    await openTerminal(page, pcId);
    await becomeRoot(page);
    await typeCmd(page, 'ip addr add 10.0.1.2/24 dev eth0');
    await typeCmd(page, "printf 'nameserver 10.0.1.10\\n' > /etc/resolv.conf");
    await typeCmd(page, "printf '10.0.1.99 serveur.domaine.local\\n' >> /etc/hosts");

    await typeCmd(page, 'getent hosts serveur.domaine.local');
    await waitForText(page, '10.0.1.99');

    await typeCmd(page, "sed -i 's/^hosts:.*/hosts: dns files/' /etc/nsswitch.conf");
    await typeCmd(page, 'getent hosts serveur.domaine.local');
    await waitForText(page, '10.0.1.88');
  });
});
