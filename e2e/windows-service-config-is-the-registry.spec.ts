import { test, expect, type Page } from '@playwright/test';

/**
 * `sc qc` et `reg query` doivent raconter la même chose, dans le même
 * terminal, à la seconde près.
 *
 * `HKLM:\SYSTEM\CurrentControlSet\Services\<nom>` n'est pas une copie de
 * la configuration d'un service : c'est là qu'elle vit, et c'est ce que
 * le SCM relit au démarrage. Tant que la projection était pilotée depuis
 * l'extérieur du gestionnaire de services, `sc config start= disabled`
 * affichait DISABLED tandis que la ruche gardait `Start=0x2`.
 *
 * Équivalent e2e de `windows-service-config-is-the-registry.test.ts`.
 */

const SERVICES = 'HKLM\\SYSTEM\\CurrentControlSet\\Services';

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

test.describe('Windows : la configuration d\'un service EST sa clé de registre', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    // Un serveur : `sc config` demande des droits d'administrateur, et un
    // poste client ouvre sa session de terminal sur `User`.
    await openTerminal(page, await addDevice(page, 'windows-server'));
  });

  test('`sc config start= disabled` fait dire DISABLED aux deux lectures', async ({ page }) => {
    await typeCmd(page, 'sc config Spooler start= disabled');
    await typeCmd(page, 'sc qc Spooler');
    await typeCmd(page, `reg query ${SERVICES}\\Spooler /v Start`);

    const text = await modalText(page);
    expect(text).toContain('DISABLED');
    // 4 = SERVICE_DISABLED. Un `0x2` ici serait la contradiction même.
    expect(text).toContain('0x4');
    expect(text).not.toContain('0x2');
  });

  test('`sc delete` emporte la clé avec le service', async ({ page }) => {
    await typeCmd(page, 'sc create LabAgent binPath= "C:\\Lab\\agent.exe"');
    await typeCmd(page, `reg query ${SERVICES}\\LabAgent`);
    expect(await modalText(page)).toContain('C:\\Lab\\agent.exe');

    await typeCmd(page, 'sc delete LabAgent');
    await typeCmd(page, `reg query ${SERVICES}\\LabAgent`);

    expect(await modalText(page)).toContain('ERROR: The system was unable to find');
  });
});
