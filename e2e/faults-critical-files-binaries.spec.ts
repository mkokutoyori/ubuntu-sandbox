/**
 * F7.7 / F7.5 over the real UI — a deleted binary, and a command whose key
 * file is gone.
 *
 * The e2e counterpart of
 * src/__tests__/unit/network-v2/faults/fault-files-binaries.test.ts.
 *
 * These two failures are deliberately kept apart because they are not the
 * same failure: a missing executable is the SHELL failing to exec it (127),
 * a missing data file is the PROGRAM refusing to work (1). An operator who
 * cannot tell them apart cannot repair either one, so the exit code is
 * asserted here as well as the message.
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

async function outputSince(page: Page, marker: string): Promise<string> {
  const all = await modalText(page);
  const idx = all.lastIndexOf(marker);
  return idx < 0 ? all : all.slice(idx + marker.length);
}

async function addPc(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = { addDevice(t: string, x: number, y: number): { id: string } };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    return store.getState().addDevice('linux-pc', 320, 280).id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('F7.7 — un binaire supprimé (UI réelle)', () => {
  test('nominal : `ls` fonctionne', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'ls /');
    expect(await outputSince(page, 'ls /')).toContain('etc');
  });

  test('après suppression, le shell ne peut plus l\'exécuter, et le dit avec son chemin', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /usr/bin/ls');
    await typeCmd(page, 'ls /');

    // Un vrai shell nomme le chemin qu'il a échoué à exécuter.
    expect(await outputSince(page, 'ls /')).toContain('/bin/ls: No such file or directory');
  });

  test('le code de retour est 127 — celui sur lequel les scripts branchent', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /usr/bin/ls');
    await typeCmd(page, 'ls / ; echo rc=$?');

    expect(await outputSince(page, 'ls / ; echo rc=$?')).toContain('rc=127');
  });

  test('seule cette commande casse — ses voisines sont intactes', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /usr/bin/ls');
    await typeCmd(page, 'echo still-here');
    expect(await outputSince(page, 'echo still-here')).toContain('still-here');

    await typeCmd(page, 'cat /etc/hostname');
    expect(await outputSince(page, 'cat /etc/hostname')).not.toContain('No such file');
  });

  test('restaurer le binaire remet la commande en marche', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /usr/bin/ls');
    await typeCmd(page, 'ls /');
    expect(await outputSince(page, 'ls /')).toContain('No such file or directory');

    await typeCmd(page, "sudo sh -c 'echo x > /usr/bin/ls'");
    await typeCmd(page, 'ls /');
    expect(await outputSince(page, 'ls /')).toContain('etc');
  });

  test('un nom que l\'image n\'a jamais livré n\'est pas concerné par le contrôle', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    // `cd` est un builtin : il vit dans le processus, pas sur le disque —
    // aucun fichier dont l'absence pourrait le casser.
    await typeCmd(page, 'cd /etc ; pwd');
    expect(await outputSince(page, 'cd /etc ; pwd')).toContain('/etc');
  });
});

test.describe('F7.5 — une commande dont le fichier clé a disparu (UI réelle)', () => {
  test('nominal : `sudo` fonctionne', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo whoami');
    expect(await outputSince(page, 'sudo whoami')).toContain('root');
  });

  test('`sudo rm /etc/sudoers` fait refuser sudo, avec son propre message', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /etc/sudoers');
    await typeCmd(page, 'sudo whoami');

    // Le binaire va bien ; c'est la politique dont il a besoin qui manque.
    expect(await outputSince(page, 'sudo whoami')).toContain('sudo: /etc/sudoers is required');
  });

  test('l\'échec est le programme qui refuse (1), pas le shell qui n\'exécute pas (127)', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /etc/sudoers');
    await typeCmd(page, 'sudo whoami ; echo rc=$?');

    const out = await outputSince(page, 'sudo whoami ; echo rc=$?');
    expect(out).toContain('rc=1');
    expect(out).not.toContain('rc=127');
  });

  test('et sudo ne peut pas se réparer lui-même — c\'est toute la leçon', async ({ page }) => {
    const pc = await addPc(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'sudo rm /etc/sudoers');
    await typeCmd(page, "sudo sh -c 'echo \"root ALL=(ALL:ALL) ALL\" > /etc/sudoers'");
    expect(await outputSince(page, '/etc/sudoers\'')).toContain('sudo: /etc/sudoers is required');

    await typeCmd(page, 'sudo whoami');
    expect(await outputSince(page, 'sudo whoami')).toContain('sudo: /etc/sudoers is required');
  });
});
