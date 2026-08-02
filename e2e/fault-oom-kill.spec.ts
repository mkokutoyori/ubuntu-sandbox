import { test, expect, type Page } from '@playwright/test';

/**
 * §F5.9 — le OOM killer dans le vrai terminal.
 *
 * On abaisse `MemoryMax=` sous la taille connue du démon avec une VRAIE
 * commande (`systemctl set-property`), et le noyau le tue au démarrage
 * suivant. Aucune allocation n'est simulée : le PRD borne le modèle au
 * déclaratif, sans comptabilité mémoire réelle.
 *
 * Équivalent e2e de
 * `src/__tests__/unit/network-v2/faults/fault-oom-kill.test.ts`.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
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

async function lastLines(page: Page, n = 14): Promise<string> {
  return (await modalText(page)).split('\n').slice(-n).join('\n');
}

test.describe('§F5.9 — MemoryMax dépassé : le OOM killer frappe', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    // Un serveur : son terminal s'ouvre en root, et `set-property` en a
    // besoin.
    await openTerminal(page, await addDevice(page, 'linux-server'));
  });

  test('le service passe `failed` avec le résultat `oom-kill`', async ({ page }) => {
    await typeCmd(page, 'systemctl set-property ssh MemoryMax=1M');
    await typeCmd(page, 'systemctl restart ssh');

    await typeCmd(page, 'systemctl is-active ssh');
    expect(await lastLines(page, 3)).toContain('failed');

    await typeCmd(page, 'systemctl status ssh');
    const status = await lastLines(page, 14);
    // `oom-kill` et pas `exit-code` : la cause est distincte, et c'est ce
    // mot qui envoie l'opérateur regarder la mémoire.
    expect(status).toContain('Active: failed (Result: oom-kill)');
    expect(status).toContain('code=killed, signal=KILL');
  });

  test('le journal porte la ligne du noyau', async ({ page }) => {
    await typeCmd(page, 'systemctl set-property ssh MemoryMax=1M');
    await typeCmd(page, 'systemctl restart ssh');

    await typeCmd(page, 'journalctl -u ssh -n 10');
    expect(await lastLines(page, 14)).toMatch(/Out of memory: Killed process \d+ \(ssh\)/);
  });

  test('relever le plafond fait repartir le service', async ({ page }) => {
    await typeCmd(page, 'systemctl set-property ssh MemoryMax=1M');
    await typeCmd(page, 'systemctl restart ssh');

    await typeCmd(page, 'systemctl set-property ssh MemoryMax=infinity');
    await typeCmd(page, 'systemctl restart ssh');

    await typeCmd(page, 'systemctl is-active ssh');
    const out = await lastLines(page, 3);
    expect(out).toContain('active');
    expect(out).not.toContain('failed');
  });
});
