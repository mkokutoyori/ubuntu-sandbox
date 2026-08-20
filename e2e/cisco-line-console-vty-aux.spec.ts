import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 2 (e2e) — Configuration et comportement des lignes console,
 * VTY et AUX, pilotée depuis la vraie UI terminal :
 *   - `privilege level N` sur une ligne prime sur le privilège du compte
 *     (console).
 *   - `transport input ssh` bloque effectivement Telnet entrant, avec
 *     exactement `% Connection refused by remote host` (critère de
 *     réussite officiel du scénario).
 *   - `exec-timeout` déconnecte réellement une session VTY distante,
 *     visible côté client SSH par `Connection to X closed.` (deuxième
 *     critère de réussite officiel).
 *   - `logging synchronous` est bien persisté dans la configuration.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

interface StoreState {
  addDevice(type: string, x: number, y: number): { id: string };
  deviceInstances: Map<string, Record<string, unknown>>;
  addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
}

async function addRouter(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate((pos) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    return store.getState().addDevice('router-cisco', pos.x, pos.y).id;
  }, { x, y });
}

/** Two Cisco routers directly cabled, both with an L3 address on Gi0/0. */
async function buildTwoRouterLan(page: Page): Promise<{ r1: string; r2: string }> {
  const r1 = await addRouter(page, 300, 250);
  const r2 = await addRouter(page, 700, 250);
  await page.evaluate(async (ids) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const d1 = store.getState().deviceInstances.get(ids.r1) as Record<string, unknown>;
    const d2 = store.getState().deviceInstances.get(ids.r2) as Record<string, unknown>;
    store.getState().addConnection(ids.r1, 'GigabitEthernet0/0', ids.r2, 'GigabitEthernet0/0', 'ethernet');
    const exec1 = d1.executeCommand as (cmd: string) => Promise<string>;
    const exec2 = d2.executeCommand as (cmd: string) => Promise<string>;
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
      await exec1.call(d1, cmd);
    }
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']) {
      await exec2.call(d2, cmd);
    }
  }, { r1, r2 });
  return { r1, r2 };
}

async function addLinuxPc(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate((pos) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    return store.getState().addDevice('linux-pc', pos.x, pos.y).id;
  }, { x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}
async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(200);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}
async function waitForText(page: Page, needle: string | RegExp, timeout = 6_000): Promise<void> {
  await expect.poll(async () => {
    const t = await modalText(page);
    return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
  }, { timeout }).toBe(true);
}
async function submitUsername(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
async function submitPassword(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

test.describe('Scénario 2 (e2e) — lignes console, VTY et AUX', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("'privilege level 15' sur 'line console 0' accorde le niveau 15 à un compte configuré à un niveau inférieur", async ({ page }) => {
    const id = await addRouter(page, 400, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'username operateur privilege 1 secret Oper@2025');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'privilege level 15');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'end');

    await closeTerminal(page);
    await openTerminal(page, id);

    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'operateur');
    await waitForText(page, 'Password:');
    await submitPassword(page, 'Oper@2025');

    await typeCmd(page, 'show privilege');
    await waitForText(page, 'Current privilege level is 15');
  });

  test("'transport input ssh' produit exactement '% Connection refused by remote host' pour une tentative Telnet sortante", async ({ page }) => {
    const { r1, r2 } = await buildTwoRouterLan(page);

    await openTerminal(page, r1);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'line vty 0 4');
    await typeCmd(page, 'transport input ssh');
    await typeCmd(page, 'end');
    await closeTerminal(page);

    await openTerminal(page, r2);
    await typeCmd(page, 'telnet 10.0.0.1');
    await waitForText(page, '% Connection refused by remote host');
  });

  test("'logging synchronous' sous 'line console 0' est persisté dans la configuration réelle", async ({ page }) => {
    const id = await addRouter(page, 400, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'line console 0');
    await typeCmd(page, 'login local');
    await typeCmd(page, 'logging synchronous');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show running-config');
    await waitForText(page, 'logging synchronous');
  });

  test("l'exec-timeout d'une VTY distante ferme réellement la session SSH, visible côté client par 'Connection to X closed.'", async ({ page }) => {
    const cisco = await addRouter(page, 700, 250);
    const pc = await addLinuxPc(page, 300, 250);
    await page.evaluate(async (ids) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const dev = store.getState().deviceInstances.get(ids.cisco) as Record<string, unknown>;
      const pcDev = store.getState().deviceInstances.get(ids.pc) as Record<string, unknown>;
      const pcPorts = (pcDev.getPortNames as () => string[])();
      const pcPort = pcPorts.find((n: string) => n.startsWith('eth')) ?? pcPorts[0];
      store.getState().addConnection(ids.pc, pcPort, ids.cisco, 'GigabitEthernet0/0', 'ethernet');
      const exec = dev.executeCommand as (cmd: string) => Promise<string>;
      for (const cmd of [
        'enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
        'username admin privilege 15 secret Admin@2025',
        'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
        'line vty 0 4', 'login local', 'transport input ssh', 'exec-timeout 0 3', 'exit',
        'end',
      ]) await exec.call(dev, cmd);
      const pcExec = pcDev.executeCommand as (cmd: string) => Promise<string>;
      await pcExec.call(pcDev, `sudo ip addr add 10.0.0.10/24 dev ${pcPort}`);
    }, { cisco, pc });

    await openTerminal(page, pc);
    await typeCmd(page, 'ssh admin@10.0.0.1');
    await waitForText(page, /password/i);
    await submitPassword(page, 'Admin@2025');
    await waitForText(page, /\w+[#>]\s*$/m, 8_000);

    await waitForText(page, 'Connection to 10.0.0.1 closed.', 20_000);
  });
});
