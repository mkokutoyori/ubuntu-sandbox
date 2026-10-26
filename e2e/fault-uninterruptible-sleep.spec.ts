import { test, expect, type Page } from '@playwright/test';

/**
 * §F5.7 — l'état `D` dans le vrai terminal : `kill -9` réussit, et ne tue
 * rien. Le signal n'est pas perdu, il attend que la ressource revienne.
 *
 * Équivalent e2e de
 * `src/__tests__/unit/network-v2/faults/fault-uninterruptible-sleep.test.ts`.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

/**
 * Deux serveurs câblés par un switch ; le serveur sert son export pour de
 * bon (NFS est un vrai protocole : un montage vers une machine qui n'exporte
 * rien est refusé) et le client monte /mnt/data depuis lui.
 */
async function buildLab(page: Page): Promise<{ client: string; farCable: string }> {
  return page.evaluate(async () => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addDevice(t: string, x: number, y: number): { id: string };
        addConnection(a: string, ai: string, b: string, bi: string): { id: string };
        deviceInstances: Map<string, Record<string, unknown>>;
      };
    };
    const s = store.getState();
    const cli = s.addDevice('linux-server', 250, 250);
    const sw = s.addDevice('switch-generic', 450, 250);
    const srv = s.addDevice('linux-server', 650, 250);
    const swPorts = (store.getState().deviceInstances.get(sw.id) as Record<string, unknown>)
      .getPortNames as () => string[];
    const ports = swPorts.call(store.getState().deviceInstances.get(sw.id));
    s.addConnection(cli.id, 'eth0', sw.id, ports[0]);
    const far = s.addConnection(srv.id, 'eth0', sw.id, ports[1]);
    const run = async (id: string, command: string): Promise<void> => {
      const dev = store.getState().deviceInstances.get(id) as Record<string, unknown>;
      await (dev.executeCommand as (c: string) => Promise<string>).call(dev, command);
    };
    await run(cli.id, 'ip addr add 10.0.0.1/24 dev eth0');
    await run(srv.id, 'ip addr add 10.0.0.2/24 dev eth0');
    await run(srv.id, 'mkdir -p /export');
    await run(srv.id, 'sh -c \'echo "/export 10.0.0.0/24(rw,sync,no_root_squash)" > /etc/exports\'');
    await run(srv.id, 'systemctl start rpcbind');
    await run(srv.id, 'systemctl start nfs-kernel-server');
    await run(cli.id, 'mkdir -p /mnt/data');
    await run(cli.id, 'mount -t nfs 10.0.0.2:/export /mnt/data');
    return { client: cli.id, farCable: far.id };
  });
}

async function pullCable(page: Page, id: string): Promise<void> {
  await page.evaluate((cableId) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { removeConnection(id: string): void };
    };
    store.getState().removeConnection(cableId);
  }, id);
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

/**
 * Le pid du DERNIER job annoncé (`[1] 1234`). Le modal garde tout le
 * scrollback et l'annonce n'est pas forcément la dernière ligne : le
 * prompt qui suit la pousse d'un cran.
 */
async function lastJobPid(page: Page): Promise<string> {
  const all = [...(await modalText(page)).matchAll(/\[\d+\]\s+(\d+)/g)];
  expect(all.length, 'aucune annonce de job dans le terminal').toBeGreaterThan(0);
  return all[all.length - 1][1];
}

test.describe('§F5.7 — attente ininterruptible sur un montage mort', () => {
  let farCable = '';

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const lab = await buildLab(page);
    farCable = lab.farCable;
    await openTerminal(page, lab.client);
  });

  test('le montage réseau apparaît avec son serveur', async ({ page }) => {
    await typeCmd(page, 'mount');
    expect(await modalText(page)).toContain('10.0.0.2:/export on /mnt/data type nfs');
  });

  test('un accès en arrière-plan part en `D` et résiste à kill -9', async ({ page }) => {
    await pullCable(page, farCable);
    await typeCmd(page, 'ls /mnt/data &');
    const pid = await lastJobPid(page);

    await typeCmd(page, 'ps aux');
    const row = (await modalText(page)).split('\n')
      .filter((l) => l.trim().split(/\s+/)[1] === pid).pop();
    expect(row, 'le job devrait apparaître dans ps').toBeTruthy();
    expect(row!.trim().split(/\s+/)[7]).toBe('D');

    // `kill` ne dit rien : c'est ce qui égare l'opérateur.
    await typeCmd(page, `kill -9 ${pid}`);
    await typeCmd(page, 'ps aux');
    const after = (await modalText(page)).split('\n')
      .filter((l) => l.trim().split(/\s+/)[1] === pid && l.includes('/mnt/data')).pop();
    expect(after, 'le processus aurait dû survivre au kill -9').toBeTruthy();
  });

  test('`umount -l` libère, et le signal en attente tombe enfin', async ({ page }) => {
    await pullCable(page, farCable);
    await typeCmd(page, 'ls /mnt/data &');
    const pid = await lastJobPid(page);
    await typeCmd(page, `kill -9 ${pid}`);

    await typeCmd(page, 'umount -l /mnt/data');

    await typeCmd(page, 'ps aux');
    const gone = (await modalText(page)).split('\n')
      .filter((l) => l.trim().split(/\s+/)[1] === pid && l.includes('/mnt/data')).pop();
    expect(gone, 'le kill -9 mis en attente aurait dû s\'appliquer').toBeFalsy();
  });
});
