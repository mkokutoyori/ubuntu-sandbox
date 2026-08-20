import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
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

async function waitForText(page: Page, needle: string, timeout = 8_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

interface Lab {
  attacker: string;
  server: string;
}

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const attacker = store.getState().addDevice('linux-pc', 200, 250);
    const server = store.getState().addDevice('linux-server', 600, 250);
    store.getState().addConnection(attacker.id, 'eth0', server.id, 'eth0', 'ethernet');

    const attackerDev = store.getState().deviceInstances.get(attacker.id) as Record<string, unknown>;
    const serverDev = store.getState().deviceInstances.get(server.id) as Record<string, unknown>;
    const attackerExec = attackerDev.executeCommand as (c: string) => Promise<string>;
    const serverExec = serverDev.executeCommand as (c: string) => Promise<string>;

    return Promise.resolve()
      .then(() => attackerExec.call(attackerDev, 'sudo ip addr add 10.0.0.20/24 dev eth0'))
      .then(() => serverExec.call(serverDev, 'ip addr add 10.0.0.10/24 dev eth0'))
      .then(() => serverExec.call(serverDev, "useradd -m alice; echo 'alice:correct-horse-battery-staple' | chpasswd"))
      .then(() => ({ attacker: attacker.id, server: server.id }));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 6 — corrélation croisée des logs (UI réelle)', () => {
  test('force brute SSH → ban Fail2ban tracé dans auth.log ET journalctl -u fail2ban', async ({ page }) => {
    const { attacker, server } = await buildLab(page);

    await page.evaluate(async ({ attackerId }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(attackerId) as Record<string, unknown>;
      const exec = dev.executeCommand as (c: string) => Promise<string>;
      for (let i = 0; i < 5; i++) {
        await exec.call(dev, 'sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }
    }, { attackerId: attacker });

    await openTerminal(page, server);
    await typeCmd(page, 'cat /var/log/auth.log');
    await waitForText(page, 'Failed password for alice from 10.0.0.20');

    await typeCmd(page, 'journalctl -u fail2ban');
    await waitForText(page, 'Ban 10.0.0.20');
  });
});
