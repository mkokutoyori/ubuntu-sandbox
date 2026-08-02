import { test, expect, type Page } from '@playwright/test';

/**
 * §F5.8 — la table des processus est pleine, dans le vrai terminal.
 *
 * `ulimit -u` était un affichage : la valeur sortait, rien ne la faisait
 * respecter. On abaisse le plafond et le `fork()` échoue pour de bon, avec
 * le transcript de bash — ses quatre tentatives avant l'abandon.
 *
 * Aucune fork bomb n'est déclenchée : on plafonne et on refuse, comme le
 * PRD l'exige, donc le navigateur n'a rien à ramer.
 *
 * Équivalent e2e de
 * `src/__tests__/unit/network-v2/faults/fault-process-table-full.test.ts`.
 */

const EAGAIN = 'bash: fork: Resource temporarily unavailable';

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

async function lastLines(page: Page, n = 8): Promise<string> {
  return (await modalText(page)).split('\n').slice(-n).join('\n');
}

test.describe('§F5.8 — table des processus pleine', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    // Un PC : son terminal s'ouvre en utilisateur non privilégié, et
    // c'est justement celui que `RLIMIT_NPROC` concerne.
    await openTerminal(page, await addDevice(page, 'linux-pc'));
  });

  test('`ulimit -u` affiche la limite, et l\'abaisser la change', async ({ page }) => {
    await typeCmd(page, 'ulimit -u');
    expect(await lastLines(page, 3)).toContain('15730');

    await typeCmd(page, 'ulimit -u 5');
    await typeCmd(page, 'ulimit -u');
    expect(await lastLines(page, 3)).toContain('5');
  });

  test('au plafond, `cmd &` répond le transcript de bash', async ({ page }) => {
    await typeCmd(page, 'ulimit -u 1');

    await typeCmd(page, 'sleep 100 &');

    const out = await lastLines(page, 8);
    expect(out).toContain(EAGAIN);
    // Les quatre tentatives : c'est ce qui fait reconnaître la panne.
    expect(out.split('retry:').length - 1).toBe(4);
  });

  test('le processus refusé n\'apparaît pas dans `ps`', async ({ page }) => {
    await typeCmd(page, 'ulimit -u 1');
    await typeCmd(page, 'sleep 12345 &');

    await typeCmd(page, 'ps aux');
    // Le modal garde tout le scrollback, l'écho de la commande tapée
    // compris : seule une VRAIE ligne de `ps` a un pid en 2e colonne.
    const psRows = (await modalText(page)).split('\n')
      .filter((l) => /^\S+\s+\d+\s/.test(l.trim()));
    expect(psRows.some((l) => l.includes('sleep 12345'))).toBe(false);
  });

  test('remonter la limite souple remet la machine en état de forker', async ({ page }) => {
    await typeCmd(page, 'ulimit -u 1');
    await typeCmd(page, 'sleep 100 &');
    expect(await lastLines(page, 8)).toContain(EAGAIN);

    await typeCmd(page, 'ulimit -u 500');

    await typeCmd(page, 'sleep 100 &');
    const out = await lastLines(page, 3);
    expect(out).toMatch(/\[\d+\]\s+\d+/);
    expect(out).not.toContain(EAGAIN);
  });
});
