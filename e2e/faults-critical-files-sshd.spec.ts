/**
 * F7.1 / F7.2 over the real UI — deleting sshd's own files breaks SSH.
 *
 * The e2e counterpart of
 * src/__tests__/unit/network-v2/faults/fault-files-sshd.test.ts. The unit
 * tests call `executeCommand` on a device built in a fixture; here the
 * operator types `rm` into a terminal the application opened, and then
 * watches the feature stop working from another machine's terminal.
 *
 * What that catches which the unit layer cannot: that the service's config
 * check is reached through the real dispatch the UI drives (not only the
 * direct API), and that the failure text actually lands on screen instead
 * of being swallowed somewhere between the device and the renderer.
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 15_000 },
  );
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(600);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
  await answerSudoPrompt(page);
}

/**
 * `sudo` on a fresh machine challenges for the local account's password.
 * The masked input is rendered off-viewport (the visible "password:" text
 * is a separate span), so it is driven with `focus()` rather than
 * `click()` — the pattern every password-prompt spec in this repo uses.
 * Conditional on purpose: sudo caches its credential, and once
 * `/etc/sudoers` is gone it never gets as far as asking.
 */
async function answerSudoPrompt(page: Page): Promise<void> {
  const pw = page.locator('[data-testid="terminal-modal"] input[type="password"]').last();
  if (await pw.count() === 0) return;
  await pw.focus();
  await pw.fill('admin');
  await pw.press('Enter');
  await page.waitForTimeout(400);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

/** Everything the terminal has shown since `marker` was last typed. */
async function outputSince(page: Page, marker: string): Promise<string> {
  const all = await modalText(page);
  const idx = all.lastIndexOf(marker);
  return idx < 0 ? all : all.slice(idx + marker.length);
}

interface Lab { client: string; srv: string }

/** PC1 (10.0.0.1/24) cabled to SRV1 (10.0.0.2/24). */
async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const client = store.getState().addDevice('linux-pc', 220, 260);
    const srv = store.getState().addDevice('linux-server', 620, 260);
    store.getState().addConnection(client.id, 'eth0', srv.id, 'eth0', 'ethernet');

    const clientDev = store.getState().deviceInstances.get(client.id) as Record<string, unknown>;
    const srvDev = store.getState().deviceInstances.get(srv.id) as Record<string, unknown>;
    const run = (d: Record<string, unknown>, c: string) =>
      (d.executeCommand as (x: string) => Promise<string>).call(d, c);

    return Promise.resolve()
      .then(() => run(clientDev, 'sudo ip addr add 10.0.0.1/24 dev eth0'))
      .then(() => run(srvDev, 'sudo ip addr add 10.0.0.2/24 dev eth0'))
      .then(() => ({ client: client.id, srv: srv.id }));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('F7.1 — /etc/ssh/sshd_config supprimé (UI réelle)', () => {
  test('nominal : le service est actif avant toute suppression', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await outputSince(page, 'systemctl is-active ssh')).toContain('active');
  });

  test('après `rm`, le redémarrage échoue avec le message exact du démon', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'sudo rm /etc/ssh/sshd_config');
    await typeCmd(page, 'sudo systemctl restart ssh');

    const out = await outputSince(page, 'sudo systemctl restart ssh');
    expect(out).toContain('/etc/ssh/sshd_config');
    expect(out).toMatch(/No such file or directory/);

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await outputSince(page, 'systemctl is-active ssh')).not.toContain('active');
  });

  test('et SSH cesse vraiment de répondre, vu depuis le poste client', async ({ page }) => {
    const { client, srv } = await buildLab(page);

    await openTerminal(page, srv);
    await typeCmd(page, 'sudo rm /etc/ssh/sshd_config');
    await typeCmd(page, 'sudo systemctl restart ssh');
    await closeTerminal(page);

    // C'est l'assertion qui compte : la fonctionnalité a disparu, elle
    // n'est pas seulement signalée quelque part (PRD-Pannes §2, O2).
    await openTerminal(page, client);
    await typeCmd(page, 'ssh alice@10.0.0.2 hostname');
    expect(await outputSince(page, 'ssh alice@10.0.0.2 hostname'))
      .toMatch(/Connection refused|No route to host|refused/i);
  });

  test('un fichier VIDE reste légal : absent n\'est pas vide', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'sudo truncate -s 0 /etc/ssh/sshd_config');
    await typeCmd(page, 'sudo systemctl restart ssh');
    await typeCmd(page, 'systemctl is-active ssh');

    expect(await outputSince(page, 'systemctl is-active ssh')).toContain('active');
  });

  test('restaurer le fichier remet le service en marche, sans résidu', async ({ page }) => {
    const { client, srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'sudo rm /etc/ssh/sshd_config');
    await typeCmd(page, 'sudo systemctl restart ssh');
    await typeCmd(page, 'systemctl is-active ssh');
    expect(await outputSince(page, 'systemctl is-active ssh')).not.toContain('active');

    await typeCmd(page, "sudo sh -c 'echo Port 22 > /etc/ssh/sshd_config'");
    await typeCmd(page, 'sudo systemctl restart ssh');
    await typeCmd(page, 'systemctl is-active ssh');
    expect(await outputSince(page, 'systemctl is-active ssh')).toContain('active');
    await closeTerminal(page);

    await openTerminal(page, client);
    await typeCmd(page, 'nc -zv 10.0.0.2 22');
    expect(await outputSince(page, 'nc -zv 10.0.0.2 22')).toMatch(/succeeded|open/i);
  });
});

test.describe('F7.2 — clés d\'hôte supprimées (UI réelle)', () => {
  test('sshd refuse de démarrer avec le message exact d\'OpenSSH', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_ecdsa_key');
    await typeCmd(page, 'sudo systemctl restart ssh');

    expect(await outputSince(page, 'sudo systemctl restart ssh'))
      .toContain('sshd: no hostkeys available -- exiting.');

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await outputSince(page, 'systemctl is-active ssh')).not.toContain('active');
  });

  test('perdre UN algorithme est survivable : il faut une clé, pas celle-là', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, "sudo sh -c 'echo stub > /etc/ssh/ssh_host_rsa_key'");
    await typeCmd(page, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key');
    await typeCmd(page, 'sudo systemctl restart ssh');
    await typeCmd(page, 'systemctl is-active ssh');

    expect(await outputSince(page, 'systemctl is-active ssh')).toContain('active');
  });

  test('la config est signalée avant les clés, dans l\'ordre où sshd les lit', async ({ page }) => {
    const { srv } = await buildLab(page);
    await openTerminal(page, srv);

    await typeCmd(page, 'sudo rm /etc/ssh/sshd_config');
    await typeCmd(page, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_ecdsa_key');
    await typeCmd(page, 'sudo systemctl restart ssh');

    const out = await outputSince(page, 'sudo systemctl restart ssh');
    expect(out).toContain('sshd_config');
    expect(out).not.toContain('no hostkeys available');
  });
});
