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

/** Deux serveurs câblés par un switch, avec /mnt/data monté en NFS. */
async function buildLab(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addDevice(t: string, x: number, y: number): { id: string };
        addConnection(a: string, ai: string, b: string, bi: string): unknown;
      };
    };
    const s = store.getState();
    const cli = s.addDevice('linux-server', 250, 250);
    const sw = s.addDevice('switch-generic', 450, 250);
    const srv = s.addDevice('linux-server', 650, 250);
    s.addConnection(cli.id, 'eth0', sw.id, 'Fa0/1');
    s.addConnection(srv.id, 'eth0', sw.id, 'Fa0/2');
    return cli.id;
  });
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
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await buildLab(page));
    // Le serveur est câblé mais n'a pas encore d'adresse : le montage vise
    // une machine que rien ne rend joignable, donc il est mort d'emblée —
    // le même fait physique qu'un serveur éteint.
    await typeCmd(page, 'mkdir -p /mnt/data');
    await typeCmd(page, 'mount -t nfs 10.0.0.2:/export /mnt/data');
  });

  test('le montage réseau apparaît avec son serveur', async ({ page }) => {
    await typeCmd(page, 'mount');
    expect(await modalText(page)).toContain('10.0.0.2:/export on /mnt/data type nfs');
  });

  test('un accès en arrière-plan part en `D` et résiste à kill -9', async ({ page }) => {
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
