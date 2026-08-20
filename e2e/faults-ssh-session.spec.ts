/**
 * A fault that happens WHILE you are logged in over ssh, through the real UI.
 *
 * The e2e counterpart of
 * src/__tests__/unit/network-v2/faults/fault-ssh-session-survives-or-dies.test.ts
 * and .../fault-ssh-session-cross-vendor.test.ts.
 *
 * `cable-unplug.spec.ts` already covers the easy half — the cable next to
 * the client, which the client's own socket notices. This file covers the
 * half nothing on the client's side can see:
 *
 *   - the cable pulled at the FAR end of a switch;
 *   - a switch in the middle losing power;
 *   - the remote machine itself being switched off.
 *
 * …and the case that must NOT break, which is what makes the others
 * meaningful rather than merely strict: `systemctl stop ssh` kills the
 * listener and leaves the session you are sitting in alone (Debian's
 * `ssh.service` is `KillMode=process`), which is precisely why
 * reconfiguring sshd over ssh is survivable.
 *
 * Everything is broken the way the operator breaks it — the store's own
 * `removeConnection`/`updateDevice({ isPoweredOn: false })`, the actions
 * behind the canvas gestures — never by reaching into the simulation.
 */

import { test, expect, type Page } from '@playwright/test';

const CLIENT_IP = '10.0.0.1';
const TARGET_IP = '10.0.0.2';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 15_000 },
  );
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
  await page.waitForTimeout(200);
}

async function typeCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(400);
}

/**
 * The masked input is rendered off-viewport (the visible "password:" is a
 * separate span), so it is driven with `focus()` rather than `click()` —
 * the pattern every password-prompt spec in this repo uses.
 */
async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(600);
}

function inTerminal(page: Page, text: string) {
  return page.locator('[data-testid="terminal-modal"]').getByText(text, { exact: false });
}

/** The prompt currently displayed, which is how we tell whose shell we are in. */
async function promptText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

type TargetKind = 'linux-server' | 'router-cisco' | 'router-huawei' | 'windows-pc';

interface Lab {
  client: string;
  target: string;
  sw: string;
  /** The connection between the switch and the target — the FAR cable. */
  farCable: string;
}

/**
 * CLIENT (10.0.0.1) ── SW ── TARGET (10.0.0.2).
 *
 * A switch in the middle is the whole point: with a direct cable, the
 * client's own port goes down and its socket knows. Through a switch, the
 * client's link stays perfectly up while the session is already dead.
 */
async function buildLab(page: Page, kind: TargetKind): Promise<Lab> {
  return page.evaluate(async ([targetKind, clientIp, targetIp]) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): { id: string };
      connections: Array<{ id: string; sourceDeviceId: string; targetDeviceId: string }>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const st = () => store.getState();

    const client = st().addDevice('linux-pc', 200, 260);
    const sw = st().addDevice('switch-generic', 420, 260);
    const target = st().addDevice(targetKind, 660, 260);

    const dev = (id: string) => st().deviceInstances.get(id) as Record<string, unknown>;
    const run = (d: Record<string, unknown>, c: string) =>
      Promise.resolve((d.executeCommand as (x: string) => Promise<string> | string).call(d, c));
    const portsOf = (d: Record<string, unknown>) => (d.getPortNames as () => string[])();

    const clientPort = portsOf(dev(client.id)).find(n => n.startsWith('eth'))!;
    const targetPort = portsOf(dev(target.id))[0];
    const swPorts = portsOf(dev(sw.id));

    st().addConnection(client.id, clientPort, sw.id, swPorts[0], 'ethernet');
    const far = st().addConnection(sw.id, swPorts[1], target.id, targetPort, 'ethernet');

    await run(dev(client.id), `sudo ip addr add ${clientIp}/24 dev ${clientPort}`);

    if (targetKind === 'router-cisco') {
      for (const c of [
        'enable', 'configure terminal',
        `interface ${targetPort}`, `ip address ${targetIp} 255.255.255.0`, 'no shutdown', 'exit',
        'username admin privilege 15 secret Admin@123', 'enable secret Admin@123',
        // IOS runs no SSH server without RSA host keys, and refuses to
        // generate them without a domain name.
        'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
        'line vty 0 4', 'login local', 'transport input ssh', 'end',
      ]) await run(dev(target.id), c);
    } else if (targetKind === 'router-huawei') {
      for (const c of [
        'system-view',
        `interface ${targetPort}`, `ip address ${targetIp} 255.255.255.0`, 'undo shutdown', 'quit',
        'aaa', 'local-user admin password cipher Admin@123',
        'local-user admin service-type ssh', 'local-user admin privilege level 15', 'quit',
        'rsa local-key-pair create', 'stelnet server enable',
        'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
        'ssh user admin authentication-type password',
        'ssh user admin service-type stelnet', 'quit',
      ]) await run(dev(target.id), c);
    } else if (targetKind === 'windows-pc') {
      await run(dev(target.id), `netsh interface ip set address "${targetPort}" static ${targetIp} 255.255.255.0`);
    } else {
      await run(dev(target.id), `sudo ip addr add ${targetIp}/24 dev ${targetPort}`);
    }

    return { client: client.id, target: target.id, sw: sw.id, farCable: far.id };
  }, [kind, CLIENT_IP, TARGET_IP] as const);
}

/** Pull one cable, exactly as deleting that link on the canvas does. */
async function pullCable(page: Page, id: string): Promise<void> {
  await page.evaluate((cableId) => {
    type S = { removeConnection(id: string): void };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    store.getState().removeConnection(cableId);
  }, id);
  await page.waitForTimeout(300);
}

/** Switch a device off, exactly as the properties panel's power toggle does. */
async function powerOff(page: Page, id: string): Promise<void> {
  await page.evaluate((deviceId) => {
    type S = { updateDevice(id: string, u: Record<string, unknown>): void };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    store.getState().updateDevice(deviceId, { isPoweredOn: false });
  }, id);
  await page.waitForTimeout(300);
}

/** Log in from the client's terminal and land in the remote's shell. */
async function sshInto(page: Page, user: string, password: string): Promise<void> {
  await typeCommand(page, `ssh ${user}@${TARGET_IP}`);
  await expect(inTerminal(page, 'password').first()).toBeVisible({ timeout: 12_000 });
  await typePassword(page, password);
  await expect(
    page.locator('[data-testid="terminal-modal"] input[type="text"]'),
  ).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  // Same budget as the other CLI-driven specs: a router lab boots a real
  // device and replays a full config through the real shell.
  test.setTimeout(90_000);
  await page.goto('/', { timeout: 45_000 });
  await waitForStore(page);
});

test.describe('une panne physique sous une session SSH établie (cible Linux)', () => {
  test('nominal : la session répond avant toute panne', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');
    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');

    await typeCommand(page, 'hostname');
    expect(await promptText(page)).not.toContain('Broken pipe');
  });

  test('le câble arraché À L\'AUTRE BOUT casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');
    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');

    // Le lien du client reste parfaitement up : rien de son côté ne peut
    // le savoir. Seul le chemin le sait (docs/PRD-Pannes.md §F1).
    await pullCable(page, lab.farCable);

    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('un switch intermédiaire qui perd le courant casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');
    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');

    await powerOff(page, lab.sw);

    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('la machine distante éteinte casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');
    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');

    await powerOff(page, lab.target);

    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('après la coupure, on retrouve son propre shell — pas un shell fantôme', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');
    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');

    await pullCable(page, lab.farCable);
    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });

    // La session est vraiment terminée : la commande suivante s'exécute
    // en local, elle ne repart pas vers une machine injoignable.
    await typeCommand(page, 'whoami');
    await expect(inTerminal(page, 'Broken pipe')).toHaveCount(1, { timeout: 5_000 });
  });
});

test.describe('arrêter sshd ne coupe PAS la session en cours', () => {
  test('`systemctl stop ssh` sur le serveur laisse la session vivante', async ({ page }) => {
    const lab = await buildLab(page, 'linux-server');

    await openTerminal(page, lab.client);
    await sshInto(page, 'alice', 'alice');
    await closeTerminal(page);

    // Depuis la console du serveur, pas depuis la session — c'est bien le
    // démon qu'on arrête, et rien d'autre.
    await openTerminal(page, lab.target);
    await typeCommand(page, 'sudo systemctl stop ssh');
    const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
    if (await pw.count() > 0) await typePassword(page, 'admin');
    await closeTerminal(page);

    await openTerminal(page, lab.client);
    await typeCommand(page, 'hostname');
    // KillMode=process : le listener meurt, les sessions établies survivent.
    // C'est exactement ce qui rend « reconfigurer sshd par ssh » praticable.
    await expect(inTerminal(page, 'Broken pipe')).toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('les mêmes pannes sur les autres équipements du labo', () => {
  test('cible Cisco : le câble arraché au loin casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'router-cisco');
    await openTerminal(page, lab.client);
    await sshInto(page, 'admin', 'Admin@123');

    await pullCable(page, lab.farCable);

    await typeCommand(page, 'show clock');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('cible Cisco : le routeur éteint casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'router-cisco');
    await openTerminal(page, lab.client);
    await sshInto(page, 'admin', 'Admin@123');

    await powerOff(page, lab.target);

    await typeCommand(page, 'show clock');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('cible Huawei : le câble arraché au loin casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'router-huawei');
    await openTerminal(page, lab.client);
    await sshInto(page, 'admin', 'Admin@123');

    await pullCable(page, lab.farCable);

    await typeCommand(page, 'display clock');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });

  test('cible Windows : le switch éteint casse la session', async ({ page }) => {
    const lab = await buildLab(page, 'windows-pc');
    await openTerminal(page, lab.client);
    await sshInto(page, 'Administrator', 'admin');

    await powerOff(page, lab.sw);

    await typeCommand(page, 'hostname');
    await expect(inTerminal(page, 'Broken pipe').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('F7.2 côté routeur — les clés RSA sont ce qui fait tourner SSH', () => {
  test('`crypto key zeroize rsa` coupe SSH, sans toucher à la session ouverte', async ({ page }) => {
    const lab = await buildLab(page, 'router-cisco');

    await openTerminal(page, lab.client);
    await sshInto(page, 'admin', 'Admin@123');
    await closeTerminal(page);

    await openTerminal(page, lab.target);
    // `enable secret` is set on this lab, so `enable` challenges — and the
    // answer goes into the MASKED input, not the ordinary command line.
    await typeCommand(page, 'enable');
    await expect(inTerminal(page, 'Password').first()).toBeVisible({ timeout: 10_000 });
    await typePassword(page, 'Admin@123');
    for (const c of ['configure terminal', 'crypto key zeroize rsa', 'end']) {
      await typeCommand(page, c);
    }
    await closeTerminal(page);

    // La session déjà ouverte est intacte — comme pour toute panne « le
    // listener est mort », ici comme sous Linux.
    await openTerminal(page, lab.client);
    await typeCommand(page, 'show clock');
    await expect(inTerminal(page, 'Broken pipe')).toHaveCount(0, { timeout: 5_000 });
  });
});
