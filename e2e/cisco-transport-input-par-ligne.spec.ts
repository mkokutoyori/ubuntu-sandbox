import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1500);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

async function poserRouteur(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const r = store.getState().addDevice('router-cisco', 300, 250);
    const dev = store.getState().deviceInstances.get(r.id) as Record<string, unknown>;
    (dev.powerOn as (() => void) | undefined)?.call(dev);
    return r.id;
  });
}

async function verdict(page: Page, id: string, kind: 'ssh' | 'telnet'): Promise<boolean> {
  return page.evaluate(([devId, transport]) => {
    type S = { deviceInstances: Map<string, Record<string, unknown>> };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const dev = store.getState().deviceInstances.get(devId) as unknown as {
      vtyAdmissionVerdict(t: string, ip: string): { accept: boolean };
    };
    return dev.vtyAdmissionVerdict(transport, '10.0.0.5').accept;
  }, [id, kind] as const);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('transport input est une directive de LIGNE', () => {
  test('durcir les vty du haut ne ferme pas celles du bas', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserRouteur(page);
    await openTerminal(page, id);
    for (const c of [
      'enable',
      'configure terminal',
      'hostname BORD',
      'ip domain-name labo.local',
      'crypto key generate rsa modulus 1024',
      'username admin privilege 15 secret Admin15',
      'line vty 0 4',
      'login local',
      'transport input ssh',
      'line vty 5 15',
      'login local',
      'transport input none',
      'end',
    ]) await typeCmd(page, c);

    expect(await verdict(page, id, 'ssh')).toBe(true);
    expect(await verdict(page, id, 'telnet')).toBe(false);

    await typeCmd(page, 'show running-config');
    await waitForText(page, 'line vty 0 4');
    const texte = await modalText(page);
    expect(texte).toContain('transport input ssh');
    expect(texte).toContain('line vty 5 15');
    expect(texte).toContain('transport input none');
  });

  test('transport input none ferme la porte aux deux protocoles', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserRouteur(page);
    await openTerminal(page, id);
    for (const c of [
      'enable',
      'configure terminal',
      'hostname BORD',
      'ip domain-name labo.local',
      'crypto key generate rsa modulus 1024',
      'username admin privilege 15 secret Admin15',
      'line vty 0 4',
      'login local',
      'transport input none',
      'end',
    ]) await typeCmd(page, c);

    expect(await verdict(page, id, 'ssh')).toBe(false);
    expect(await verdict(page, id, 'telnet')).toBe(false);
  });
});
