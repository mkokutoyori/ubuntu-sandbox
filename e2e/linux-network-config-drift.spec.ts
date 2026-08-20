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

async function cableToSwitch(page: Page, pcId: string): Promise<void> {
  await page.evaluate((pcId) => {
    type StoreState = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const sw = store.getState().addDevice('switch-generic', 700, 300);
    const pcInst = store.getState().deviceInstances.get(pcId) as Record<string, unknown>;
    const swInst = store.getState().deviceInstances.get(sw.id) as Record<string, unknown>;
    const pcPort = ((pcInst.getPortNames as () => string[])())[0];
    const swPort = ((swInst.getPortNames as () => string[])())[0];
    store.getState().addConnection(pcId, pcPort, sw.id, swPort, 'ethernet');
  }, pcId);
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

function writeNetplanCmd(address: string): string {
  return `printf 'network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    eth0:\\n      dhcp4: false\\n      addresses:\\n        - ${address}/24\\n      gateway4: 10.0.0.1\\n      mtu: 1400\\n' > /etc/netplan/01-netcfg.yaml`;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 1 — netplan vs état réel des interfaces (UI réelle)', () => {
  test('netplan apply pousse la config déclarée vers ip addr show ; sans apply, aucun effet', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-pc');
    await cableToSwitch(page, pcId);
    await openTerminal(page, pcId);

    await becomeRoot(page);
    await typeCmd(page, writeNetplanCmd('10.0.0.50'));
    await typeCmd(page, 'netplan apply');
    await typeCmd(page, 'ip addr show eth0');
    await waitForText(page, '10.0.0.50/24');

    await typeCmd(page, writeNetplanCmd('10.0.0.77'));
    await typeCmd(page, 'ip addr show eth0');
    await waitForText(page, '10.0.0.50/24');

    await typeCmd(page, 'netplan try');
    await waitForText(page, '10.0.0.77');

    await typeCmd(page, 'ip addr show eth0');
    await waitForText(page, '10.0.0.50/24');

    await typeCmd(page, 'systemctl restart systemd-networkd');
    await typeCmd(page, 'ip addr show eth0');
    await waitForText(page, '10.0.0.77/24');
  });

  test('nmcli et networkctl reflètent la source de configuration réelle', async ({ page }) => {
    const pcId = await addDevice(page, 'linux-pc');
    await cableToSwitch(page, pcId);
    await openTerminal(page, pcId);

    await becomeRoot(page);
    await typeCmd(page, writeNetplanCmd('10.0.0.60'));
    await typeCmd(page, 'netplan apply');

    await typeCmd(page, 'nmcli device status');
    await waitForText(page, 'unmanaged');

    await typeCmd(page, 'networkctl status eth0');
    await waitForText(page, 'routable (configured)');
  });
});
