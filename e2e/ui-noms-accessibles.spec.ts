import { test, expect, type Page } from '@playwright/test';
import { fortiConsoleLogin } from './fortiConsole';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function sansNom(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const selector = 'button, [role="button"], input:not([type="hidden"]), select, textarea';
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const named = (el.getAttribute('aria-label') ?? '').trim().length > 0
        || (el.getAttribute('aria-labelledby') ?? '').trim().length > 0
        || (el.textContent ?? '').trim().length > 0
        || (el.id.length > 0
          && document.querySelector(`label[for="${CSS.escape(el.id)}"]`) !== null)
        || el.closest('label') !== null;
      if (named) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      out.push(`${el.tagName.toLowerCase()}[title=${JSON.stringify(el.getAttribute('title'))}]`
        + ` class=${JSON.stringify((el.getAttribute('class') ?? '').slice(0, 60))}`);
    }
    return out;
  });
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

test.describe('toute commande de l`interface porte un nom', () => {
  test('la toile nue n`a aucune commande muette', async ({ page }) => {
    expect(await sansNom(page)).toEqual([]);
  });

  test('le panneau de proprietes n`a aucune commande muette', async ({ page }) => {
    const id = await poserFortiGate(page);
    await page.locator(`[data-device-id="${id}"]`).first().click();
    await page.waitForTimeout(600);
    expect(await sansNom(page)).toEqual([]);
  });

  test('le terminal n`a aucune commande muette', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
    await fortiConsoleLogin(page);
    await page.waitForTimeout(600);
    expect(await sansNom(page)).toEqual([]);
  });

  test('le nom annonce dit ce que la commande FAIT, pas seulement son icone', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
    await fortiConsoleLogin(page);
    await page.waitForTimeout(600);

    const barre = page.locator('[role="region"][aria-label="Tiled terminals"]');
    await expect(barre.getByRole('button', { name: /close/i }).first()).toBeVisible();
    await expect(barre.getByRole('button', { name: /minimi/i }).first()).toBeVisible();
    await expect(barre.getByRole('button', { name: /scrollback/i }).first()).toBeVisible();
  });

  test('le panneau `Live state` d`un pare-feu DIT quelque chose', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
    await fortiConsoleLogin(page);
    await page.waitForTimeout(800);

    const saisie = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
    for (const commande of ['config system interface', 'edit port2', 'set mode static',
      'set ip 192.168.10.1 255.255.255.0', 'next', 'end']) {
      await saisie.focus();
      await saisie.fill(commande);
      await saisie.press('Enter');
      await page.waitForTimeout(200);
    }
    await page.locator('[data-testid="terminal-modal"] button[aria-label="Close the terminal"]')
      .first().click();
    await page.waitForTimeout(600);

    await page.locator(`[data-device-id="${id}"]`).first().click();
    await page.waitForTimeout(500);
    const bouton = page.getByRole('button', { name: /live state/i }).first();
    if ((await bouton.getAttribute('aria-expanded')) !== 'true') await bouton.click();
    await page.waitForTimeout(600);

    const texte = await page.locator('body').innerText();
    const debut = texte.toUpperCase().indexOf('LIVE STATE');
    const bloc = texte.slice(debut, debut + 900);
    expect(bloc).toContain('192.168.10.0');
    expect(bloc).not.toMatch(/ROUTING TABLE\s*\n\(empty\)/i);
  });

  test('le champ de saisie du terminal se nomme', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await poserFortiGate(page);
    await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
    await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
    await fortiConsoleLogin(page);
    await page.waitForTimeout(600);

    const saisie = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
    expect((await saisie.getAttribute('aria-label')) ?? '').not.toBe('');
  });
});
