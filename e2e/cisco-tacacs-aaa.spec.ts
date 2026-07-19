import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 6 (e2e) — AAA avec TACACS+, pilotée depuis la vraie UI terminal
 * (deux routeurs Cisco : un NAS et un serveur TACACS+).
 *
 * Couvre les trois critères de réussite officiels du scénario :
 *  - authentification console via TACACS+ : succès accorde directement le
 *    niveau de privilège renvoyé par le serveur ("Router#").
 *  - `test aaa group X user pass legacy` produit exactement "Attempting
 *    authentication test..." puis "User was successfully authenticated."
 *    ou "User was NOT successfully authenticated.".
 *  - `Command authorization failed.` s'affiche immédiatement (session non
 *    fermée) quand TACACS+ refuse une commande précise.
 *
 * Le serveur TACACS+ (`tac_plus` dans l'énoncé) n'a pas d'équivalent CLI
 * dans ce simulateur -- seule l'API interne `TacacsServerAgent` (déjà
 * réelle, déjà testée) existe, donc le côté serveur est configuré via
 * `page.evaluate` directement sur l'instance du second routeur, exactement
 * comme le ferait un test unitaire ; le côté NAS (sujet réel des critères
 * de réussite) est entièrement piloté depuis le vrai terminal.
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
async function waitForText(page: Page, needle: string | RegExp, timeout = 8_000): Promise<void> {
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

/** Two directly-cabled Cisco routers: `nas` (client under test) + `aaaSrv` (real TACACS+ AAA server). */
async function buildLab(page: Page): Promise<{ nas: string; aaaSrv: string }> {
  const nas = await addRouter(page, 400, 250);
  const aaaSrv = await addRouter(page, 800, 250);
  await page.evaluate(async (ids) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const nasDev = store.getState().deviceInstances.get(ids.nas) as Record<string, unknown>;
    const aaaDev = store.getState().deviceInstances.get(ids.aaaSrv) as Record<string, unknown>;
    store.getState().addConnection(ids.nas, 'GigabitEthernet0/0', ids.aaaSrv, 'GigabitEthernet0/0', 'ethernet');
    const nasExec = nasDev.executeCommand as (cmd: string) => Promise<string>;
    const aaaExec = aaaDev.executeCommand as (cmd: string) => Promise<string>;
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
      await nasExec.call(nasDev, cmd);
    }
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']) {
      await aaaExec.call(aaaDev, cmd);
    }
    const tacacsServer = (aaaDev.getTacacsServer as () => {
      setEnabled(on: boolean): void;
      setSharedSecret(s: string): void;
      addUser(u: string, p: string, priv?: number, permittedCommands?: string[]): void;
    })();
    tacacsServer.setEnabled(true);
    tacacsServer.setSharedSecret('Tacacs@2025');
    tacacsServer.addUser('netadmin', 'Admin@2025', 15);

    for (const cmd of [
      'enable', 'configure terminal',
      'aaa new-model',
      'tacacs server TACACS-MANDENG',
      'address ipv4 10.0.0.2',
      'key Tacacs@2025',
      'exit',
      'aaa group server tacacs+ TACACS-GROUP',
      'server name TACACS-MANDENG',
      'exit',
      'aaa authentication login default group TACACS-GROUP local',
      'line console 0',
      'login local',
      'exit',
      'end',
    ]) await nasExec.call(nasDev, cmd);
  }, { nas, aaaSrv });
  return { nas, aaaSrv };
}

test.describe('Scénario 6 (e2e) — AAA avec TACACS+', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("un utilisateur TACACS+ valide obtient directement le niveau 15 ('Router#') à la connexion console", async ({ page }) => {
    const { nas } = await buildLab(page);

    await openTerminal(page, nas);
    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'netadmin');
    await waitForText(page, /Password:/);
    await submitPassword(page, 'Admin@2025');

    await typeCmd(page, 'show privilege');
    await waitForText(page, 'Current privilege level is 15');
  });

  test("'test aaa group X user pass legacy' produit les messages exacts de succès et d'échec", async ({ page }) => {
    const { nas } = await buildLab(page);
    await openTerminal(page, nas);
    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'netadmin');
    await waitForText(page, /Password:/);
    await submitPassword(page, 'Admin@2025');
    await waitForText(page, /\w+[#>]\s*$/m, 6_000).catch(() => {});
    await typeCmd(page, 'enable');

    await typeCmd(page, 'test aaa group TACACS-GROUP netadmin Admin@2025 legacy');
    await waitForText(page, 'Attempting authentication test to server-group TACACS-GROUP using TACACS+');
    await waitForText(page, 'User was successfully authenticated.');

    await typeCmd(page, 'test aaa group TACACS-GROUP netadmin WrongPwd legacy');
    await waitForText(page, 'User was NOT successfully authenticated.');
  });

  test("'Command authorization failed.' s'affiche immédiatement pour une commande refusée par TACACS+, sans fermer la session", async ({ page }) => {
    const nas = await addRouter(page, 400, 250);
    const aaaSrv = await addRouter(page, 800, 250);
    await page.evaluate(async (ids) => {
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const nasDev = store.getState().deviceInstances.get(ids.nas) as Record<string, unknown>;
      const aaaDev = store.getState().deviceInstances.get(ids.aaaSrv) as Record<string, unknown>;
      store.getState().addConnection(ids.nas, 'GigabitEthernet0/0', ids.aaaSrv, 'GigabitEthernet0/0', 'ethernet');
      const nasExec = nasDev.executeCommand as (cmd: string) => Promise<string>;
      const aaaExec = aaaDev.executeCommand as (cmd: string) => Promise<string>;
      for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
        await nasExec.call(nasDev, cmd);
      }
      for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']) {
        await aaaExec.call(aaaDev, cmd);
      }
      const tacacsServer = (aaaDev.getTacacsServer as () => {
        setEnabled(on: boolean): void;
        setSharedSecret(s: string): void;
        addUser(u: string, p: string, priv?: number, permittedCommands?: string[]): void;
      })();
      tacacsServer.setEnabled(true);
      tacacsServer.setSharedSecret('Tacacs@2025');
      // Only "show version" is permitted -- everything else is denied.
      tacacsServer.addUser('netadmin', 'Admin@2025', 15, ['show version']);

      for (const cmd of [
        'enable', 'configure terminal',
        'aaa new-model',
        'tacacs server TACACS-MANDENG',
        'address ipv4 10.0.0.2',
        'key Tacacs@2025',
        'exit',
        'aaa group server tacacs+ TACACS-GROUP',
        'server name TACACS-MANDENG',
        'exit',
        'aaa authentication login default group TACACS-GROUP local',
        'aaa authorization commands 15 default group TACACS-GROUP local',
        'line console 0',
        'login local',
        'exit',
        'end',
      ]) await nasExec.call(nasDev, cmd);
    }, { nas, aaaSrv });

    await openTerminal(page, nas);
    await waitForText(page, 'User Access Verification');
    await submitUsername(page, 'netadmin');
    await waitForText(page, /Password:/);
    await submitPassword(page, 'Admin@2025');

    await typeCmd(page, 'show running-config');
    await waitForText(page, 'Command authorization failed.');

    // The session is still usable -- a permitted command still works.
    await typeCmd(page, 'show version');
    await waitForText(page, /Cisco IOS/i);
  });
});
