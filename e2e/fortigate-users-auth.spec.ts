import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await fortiConsoleLogin(page);
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

async function poserFortiGate(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const created = store.getState().addDevice('firewall-fortinet', 320, 240);
    const device = store.getState().deviceInstances.get(created.id) as Record<string, unknown>;
    (device.powerOn as (() => void) | undefined)?.call(device);
    return created.id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('FortiGate — utilisateurs et authentification dans le terminal', () => {
  test('un utilisateur local se declare et le `show` le reproduit', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config user local', 'edit "jdupont"',
      'set type password', 'set passwd "Secret2026!"',
      'next', 'end', 'show user local',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "jdupont"');
    await waitForText(page, 'set type password');
  });

  test('un groupe compose ses membres', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config user local', 'edit "jdupont"', 'set passwd "Secret2026!"', 'next', 'end',
      'config user group', 'edit "COMMERCIAUX"',
      'set member "jdupont"', 'next', 'end', 'show user group',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "COMMERCIAUX"');
    await waitForText(page, 'set member "jdupont"');
  });

  test('`diagnose firewall auth list` annonce zero au depart', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    await typeCmd(page, 'diagnose firewall auth list');

    await waitForText(page, '0 listed, 0 filtered');
  });

  test('`config user ldap` est acceptee — le dépôt a un vrai LDAP', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config user ldap', 'edit "AD"',
      'set server 10.0.0.7', 'set dn "dc=labo,dc=local"',
      'next', 'end', 'show user ldap',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "AD"');
    await waitForText(page, 'set dn "dc=labo,dc=local"');
  });

  test('FSSO est refuse en nommant la brique absente', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of ['config user fsso', 'edit "X"', 'set name "X"']) {
      await typeCmd(page, c);
    }

    await waitForText(page, 'Command fail');
    await waitForText(page, 'collector agent');
  });

  test('un profil d`acces pose ses neuf groupes de droits', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system accprofile', 'edit "readonly"',
      'set fwgrp read', 'set sysgrp read',
      'next', 'end', 'show system accprofile',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "readonly"');
    await waitForText(page, 'set fwgrp read');
  });

  test('`trusthost` est rendu dans la configuration de l`administrateur', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system admin', 'edit "auditeur"',
      'set accprofile "super_admin"',
      'set trusthost1 192.168.1.0 255.255.255.0',
      'next', 'end', 'show system admin',
    ]) await typeCmd(page, c);

    await waitForText(page, 'edit "auditeur"');
    await waitForText(page, 'set trusthost1 192.168.1.0 255.255.255.0');
  });

  test('la double authentification est refusee', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await openTerminal(page, id);

    for (const c of [
      'config system admin', 'edit "admin"', 'set two-factor fortitoken',
    ]) await typeCmd(page, c);

    await waitForText(page, 'Command fail');
  });
});
