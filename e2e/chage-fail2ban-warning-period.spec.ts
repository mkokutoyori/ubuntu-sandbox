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
  client: string;
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
    const client = store.getState().addDevice('linux-pc', 200, 250);
    const server = store.getState().addDevice('linux-server', 600, 250);
    store.getState().addConnection(client.id, 'eth0', server.id, 'eth0', 'ethernet');

    const clientDev = store.getState().deviceInstances.get(client.id) as Record<string, unknown>;
    const serverDev = store.getState().deviceInstances.get(server.id) as Record<string, unknown>;
    const clientExec = clientDev.executeCommand as (c: string) => Promise<string>;
    const serverExec = serverDev.executeCommand as (c: string) => Promise<string>;

    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 27);
    const lastChange = d.toISOString().slice(0, 10);

    return Promise.resolve()
      .then(() => clientExec.call(clientDev, 'sudo ip addr add 10.0.0.1/24 dev eth0'))
      .then(() => serverExec.call(serverDev, 'ip addr add 10.0.0.2/24 dev eth0'))
      .then(() => serverExec.call(serverDev, "useradd -m alice; echo 'alice:wonderland' | chpasswd"))
      .then(() => serverExec.call(serverDev, `chage -W 7 -M 30 -d ${lastChange} alice`))
      .then(() => ({ client: client.id, server: server.id }));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 3 — chage -W avertissement + sensibilité Fail2ban (UI réelle)', () => {
  test('une connexion réussie en période d\'avertissement affiche le message PAM sans bloquer la session', async ({ page }) => {
    const { client, server } = await buildLab(page);

    const out = await page.evaluate(async ({ clientId }) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
      const dev = store.getState().deviceInstances.get(clientId) as Record<string, unknown>;
      const exec = dev.executeCommand as (c: string) => Promise<string>;
      return exec.call(dev, 'sshpass -p wonderland ssh alice@10.0.0.2 whoami');
    }, { clientId: client });

    expect(out).toMatch(/Warning: your password will expire in 3 days\./);
    expect(out).toMatch(/^alice\s*$/m);

    await openTerminal(page, server);
    await typeCmd(page, 'cat /var/log/auth.log');
    await waitForText(page, 'Accepted password for alice from 10.0.0.1');
  });
});
