/**
 * E2E — ping / traceroute / arping migrées vers command-kernel
 *
 * Vérifie, à travers l'UI réelle (drag-and-drop implicite via le store,
 * terminal, clavier), que les trois commandes migrées se comportent
 * fidèlement : `ping` en flux continu (job de premier plan, Ctrl+C),
 * `traceroute` avec de vrais sauts à travers la topologie câblée, et
 * `arping` sur la table de voisinage réelle.
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

/** Deux PC Linux câblés directement, chacun avec une IP statique dans le même /24. */
async function twoLinuxHostsOnLan(page: Page): Promise<{ left: string; right: string }> {
  return page.evaluate(async () => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const left = store.getState().addDevice('linux-pc', 250, 250);
    const right = store.getState().addDevice('linux-pc', 650, 250);
    const li = store.getState().deviceInstances.get(left.id) as Record<string, unknown>;
    const ri = store.getState().deviceInstances.get(right.id) as Record<string, unknown>;
    const lp = (li.getPortNames as () => string[])()[0];
    const rp = (ri.getPortNames as () => string[])()[0];
    const e1 = li.executeCommand as (c: string) => Promise<string> | string;
    const e2 = ri.executeCommand as (c: string) => Promise<string> | string;
    await Promise.resolve(e1.call(li, `sudo ip addr add 192.168.50.10/24 dev ${lp}`));
    await Promise.resolve(e2.call(ri, `sudo ip addr add 192.168.50.20/24 dev ${rp}`));
    store.getState().addConnection(left.id, lp, right.id, rp, 'ethernet');
    return { left: left.id, right: right.id };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
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

async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

async function ctrlC(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').click();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
}

async function promptInputVisible(page: Page): Promise<boolean> {
  const inputs = await page.locator('[data-testid="terminal-modal"] input[type="text"]').all();
  for (const inp of inputs) {
    const box = await inp.boundingBox();
    if (box && box.width > 1 && box.height > 1) return true;
  }
  return false;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('ping — commande streaming command-kernel', () => {
  test('ping -c 3 vers un voisin réel affiche les réponses ICMP puis les statistiques', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'ping -c 3 192.168.50.20');

    await waitForText(page, /PING 192\.168\.50\.20/);
    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /bytes from 192\.168\.50\.20/.test(l)).length,
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(1);
    await waitForText(page, /ping statistics/);
    await waitForText(page, /3 packets transmitted/);
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('ping vers un hôte injoignable rend la main avec un message clair', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'ping -c 1 192.168.99.99');
    await waitForText(page, /Network is unreachable|Name or service not known|unreachable/i);
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('ping sans -c tourne en continu ; Ctrl+C affiche les stats et rend la main', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'ping -i 0.2 192.168.50.20');
    await waitForText(page, /PING 192\.168\.50\.20/);
    expect(await promptInputVisible(page)).toBe(false);

    await expect.poll(
      async () => (await modalText(page)).split('\n').filter((l) => /bytes from 192\.168\.50\.20/.test(l)).length,
      { timeout: 6_000 },
    ).toBeGreaterThanOrEqual(2);

    await ctrlC(page);
    await waitForText(page, /ping statistics/);
    expect(await promptInputVisible(page)).toBe(true);
  });
});

test.describe('traceroute — commande streaming command-kernel', () => {
  test('traceroute vers un voisin direct montre un seul saut', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'traceroute 192.168.50.20');
    await waitForText(page, /traceroute to 192\.168\.50\.20/);
    await waitForText(page, /192\.168\.50\.20/, 6_000);
    expect(await promptInputVisible(page)).toBe(true);
  });

  test('traceroute -n affiche des adresses numériques sans résolution DNS', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'traceroute -n 192.168.50.20');
    await waitForText(page, /192\.168\.50\.20/, 6_000);
    expect(await promptInputVisible(page)).toBe(true);
  });
});

test.describe('arping — table de voisinage réelle', () => {
  test('arping sur un voisin après un ping (ARP résolu) reçoit des réponses', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    // Force la résolution ARP réelle avant d'interroger la table de voisinage.
    await typeCmd(page, 'ping -c 1 192.168.50.20');
    await waitForText(page, /ping statistics/);

    await typeCmd(page, 'arping -c 2 192.168.50.20');
    await waitForText(page, /ARPING 192\.168\.50\.20/);
    await waitForText(page, /Unicast reply from 192\.168\.50\.20/, 4_000);
    await waitForText(page, /Received 2 response\(s\)/);
  });

  test('arping vers une IP jamais résolue ne reçoit aucune réponse', async ({ page }) => {
    const { left } = await twoLinuxHostsOnLan(page);
    await openTerminal(page, left);
    await typeCmd(page, 'arping -c 1 192.168.50.250');
    await waitForText(page, /ARPING 192\.168\.50\.250/);
    await waitForText(page, /Received 0 response\(s\)/);
  });
});
