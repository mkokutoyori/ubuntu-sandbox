import { test, expect, type Page } from '@playwright/test';

/**
 * Un poste Windows n'a qu'UN registre — quelle que soit la porte.
 *
 * Dans l'UI, `reg` s'exécute dans le shell `cmd` du terminal, tandis que
 * `powershell` pousse un sous-shell (`PowerShellSubShell`) qui construit
 * son propre interpréteur. C'est précisément le second site de
 * construction de `createWindowsPSProviders` : si l'usine lui rendait un
 * registre détaché, ce que `reg add` a écrit resterait invisible depuis
 * PowerShell, et inversement — sur la même machine, dans la même fenêtre.
 *
 * Équivalent e2e de `windows-one-registry-per-machine.test.ts`, joué
 * cette fois à travers le vrai terminal du navigateur.
 */

const REG_KEY = 'HKLM\\SOFTWARE\\Lab';
const PS_KEY = 'HKLM:\\SOFTWARE\\Lab';

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
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}
async function modalText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

test.describe('Windows : un seul registre par machine', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'windows-pc');
    await openTerminal(page, id);
  });

  test('ce que `reg add` a écrit, `Get-ItemProperty` le lit', async ({ page }) => {
    await typeCmd(page, `reg add ${REG_KEY} /v Site /d Douala /f`);

    await typeCmd(page, 'powershell');
    await typeCmd(page, `Get-ItemProperty -Path ${PS_KEY}`);

    expect(await modalText(page)).toContain('Douala');
  });

  test('ce que `Set-ItemProperty` a écrit, `reg query` le lit', async ({ page }) => {
    await typeCmd(page, `reg add ${REG_KEY} /v Site /d Douala /f`);

    await typeCmd(page, 'powershell');
    await typeCmd(page, `Set-ItemProperty -Path ${PS_KEY} -Name Ville -Value Yaounde`);
    await typeCmd(page, 'exit');

    // De retour dans cmd, sur la même machine : les deux valeurs côte à
    // côte. La cmdlet a ajouté à la clé que `reg` avait créée, elle ne
    // l'a pas doublée dans un second registre.
    await typeCmd(page, `reg query ${REG_KEY}`);
    const text = await modalText(page);
    expect(text).toContain('Douala');
    expect(text).toContain('Yaounde');
  });
});
