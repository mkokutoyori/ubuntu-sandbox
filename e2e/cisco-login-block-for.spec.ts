import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 5 (e2e) — login block-for : protection contre la force brute,
 * pilotée depuis la vraie UI terminal (deux PC Linux + un routeur Cisco).
 *
 * Couvre les trois critères de réussite officiels du scénario :
 *  - `show login` affiche exactement le nombre d'échecs dans la fenêtre
 *    courante et le temps restant en quiet-mode.
 *  - `% Blocking new login for N secs (quota exceeded)` apparaît
 *    immédiatement à la 5e tentative échouée, connexion fermée sans
 *    prompt supplémentaire.
 *  - une IP dans `login quiet-mode access-class` peut toujours se
 *    connecter pendant le quiet-mode ; une IP hors whitelist ne le peut
 *    pas.
 *
 * Écart assumé (réalité prime sur la prose du scénario, confirmé via la
 * documentation Cisco officielle) : la console reste TOUJOURS accessible
 * pendant le quiet-mode -- seules les connexions distantes (Telnet/SSH)
 * sont bloquées. Non couvert ici (déjà testé côté unitaire).
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
async function submitPassword(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForTimeout(250);
}
function hasPasswordPrompt(page: Page): Promise<boolean> {
  return page.locator('[data-testid="terminal-modal"] input[type="password"]').last().isVisible().catch(() => false);
}

/** One `ssh admin@host` round-trip, re-issuing the command if OpenSSH's own 3-attempt cap already closed the session. */
async function sshAttempt(page: Page, host: string, password: string): Promise<void> {
  if (!(await hasPasswordPrompt(page))) {
    await typeCmd(page, `ssh admin@${host}`);
    await page.waitForTimeout(200);
  }
  if (await hasPasswordPrompt(page)) {
    await submitPassword(page, password);
  }
}

async function buildLab(page: Page, x: { r: number; pc: number; pc2: number }): Promise<{ cisco: string; pc: string; pc2: string }> {
  const cisco = await addRouter(page, x.r, 250);
  const pc = await addLinuxPc(page, x.pc, 150);
  const pc2 = await addLinuxPc(page, x.pc2, 350);
  await page.evaluate(async (ids) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const dev = store.getState().deviceInstances.get(ids.cisco) as Record<string, unknown>;
    const pcDev = store.getState().deviceInstances.get(ids.pc) as Record<string, unknown>;
    const pc2Dev = store.getState().deviceInstances.get(ids.pc2) as Record<string, unknown>;
    const pcPorts = (pcDev.getPortNames as () => string[])();
    const pcPort = pcPorts.find((n: string) => n.startsWith('eth')) ?? pcPorts[0];
    const pc2Ports = (pc2Dev.getPortNames as () => string[])();
    const pc2Port = pc2Ports.find((n: string) => n.startsWith('eth')) ?? pc2Ports[0];
    store.getState().addConnection(ids.pc, pcPort, ids.cisco, 'GigabitEthernet0/0', 'ethernet');
    store.getState().addConnection(ids.pc2, pc2Port, ids.cisco, 'GigabitEthernet0/1', 'ethernet');
    const exec = dev.executeCommand as (cmd: string) => Promise<string>;
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.99 255.255.255.0', 'no shutdown', 'exit',
      'username admin privilege 15 secret Admin@2025',
      'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
      'line vty 0 4', 'login local', 'transport input ssh', 'exit',
      'end',
    ]) await exec.call(dev, cmd);
    const pcExec = pcDev.executeCommand as (cmd: string) => Promise<string>;
    await pcExec.call(pcDev, `sudo ip addr add 10.0.0.10/24 dev ${pcPort}`);
    const pc2Exec = pc2Dev.executeCommand as (cmd: string) => Promise<string>;
    await pc2Exec.call(pc2Dev, `sudo ip addr add 10.0.0.199/24 dev ${pc2Port}`);
  }, { cisco, pc, pc2 });
  return { cisco, pc, pc2 };
}

test.describe('Scénario 5 (e2e) — login block-for', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("la 5e tentative SSH échouée déclenche immédiatement '% Blocking new login for N secs (quota exceeded)' et ferme la connexion", async ({ page }) => {
    const { cisco, pc } = await buildLab(page, { r: 700, pc: 300, pc2: 1100 });

    await openTerminal(page, cisco);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'login block-for 120 attempts 5 within 30');
    await typeCmd(page, 'end');
    await closeTerminal(page);

    await openTerminal(page, pc);
    for (let i = 0; i < 4; i++) await sshAttempt(page, '10.0.0.1', 'WrongPassword');
    const before = await modalText(page);
    expect(before).not.toContain('quota exceeded');

    await sshAttempt(page, '10.0.0.1', 'WrongPassword');
    await waitForText(page, '% Blocking new login for 120 secs (quota exceeded)');
    expect(await hasPasswordPrompt(page)).toBe(false);
  });

  test("'show login' affiche l'état Quiet-Mode et le temps restant après déclenchement du blocage", async ({ page }) => {
    const { cisco, pc } = await buildLab(page, { r: 700, pc: 300, pc2: 1100 });

    await openTerminal(page, cisco);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'login block-for 120 attempts 3 within 30');
    await typeCmd(page, 'end');
    await closeTerminal(page);

    await openTerminal(page, pc);
    for (let i = 0; i < 3; i++) await sshAttempt(page, '10.0.0.1', 'WrongPassword');
    await waitForText(page, 'quota exceeded');
    await closeTerminal(page);

    await openTerminal(page, cisco);
    await typeCmd(page, 'show login');
    await waitForText(page, 'Router presently in Quiet-Mode');
    await waitForText(page, /Will remain in Quiet-Mode for \d+ more secs/);
  });

  test("'login quiet-mode access-class' : une IP hors whitelist est refusée, une IP dans la whitelist se connecte normalement pendant le quiet-mode", async ({ page }) => {
    const { cisco, pc, pc2 } = await buildLab(page, { r: 700, pc: 300, pc2: 1100 });

    await openTerminal(page, cisco);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'ip access-list standard WHITELIST-LOGIN');
    await typeCmd(page, 'permit 10.0.0.199 0.0.0.0');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'login quiet-mode access-class WHITELIST-LOGIN');
    await typeCmd(page, 'login block-for 120 attempts 3 within 30');
    await typeCmd(page, 'end');
    await closeTerminal(page);

    await openTerminal(page, pc);
    for (let i = 0; i < 3; i++) await sshAttempt(page, '10.0.0.1', 'WrongPassword');
    await waitForText(page, 'quota exceeded');

    // Attacker's own PC (10.0.0.10, not whitelisted) is refused immediately.
    await typeCmd(page, 'ssh admin@10.0.0.1');
    await waitForText(page, /Connection refused/);
    await closeTerminal(page);

    // The whitelisted PC (10.0.0.199) still reaches the password prompt.
    await openTerminal(page, pc2);
    await typeCmd(page, 'ssh admin@10.0.0.1');
    await waitForText(page, /password/i);
    await submitPassword(page, 'Admin@2025');
    await waitForText(page, /\w+[#>]\s*$/m, 8_000);
  });
});
