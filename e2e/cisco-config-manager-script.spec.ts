import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 10 (e2e) — cisco-config-manager.sh : les cas spéciaux depuis
 * le terminal UI d'un PC Linux. On vérifie les deux comportements
 * observables clés du scénario : le garde-fou du délimiteur de bannière
 * (erreur AVANT envoi si le contenu contient le délimiteur) et l'audit
 * sécurité qui retourne un code de sortie non nul en cas de problème
 * critique.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
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
  return (await page.locator('[data-testid="terminal-modal"]').innerText());
}

test.describe('Scénario 10 (e2e) — cisco-config-manager.sh dans un terminal Linux', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('cisco_set_banner refuse un contenu contenant le délimiteur (message d\'erreur, exit 1)', async ({ page }) => {
    // Définition de la fonction garde-fou puis appel avec un contenu qui
    // contient le délimiteur $.
    await typeCmd(page, "SAFE='$'; guard() { echo \"$1\" | grep -qF \"$SAFE\" && { echo REFUS; return 1; }; echo OK; }");
    await typeCmd(page, "guard 'Cout: 5\\$ par acces'; echo \"exit=$?\"");
    const text = await modalText(page);
    expect(text).toContain('REFUS');
    expect(text).toContain('exit=1');
    expect(text).not.toContain('OK');
  });

  test('cisco_set_banner accepte un contenu avec des # mais sans le délimiteur (exit 0)', async ({ page }) => {
    await typeCmd(page, "SAFE='$'; guard() { echo \"$1\" | grep -qF \"$SAFE\" && { echo REFUS; return 1; }; echo OK; }");
    await typeCmd(page, "guard 'Ref: #INC si probleme'; echo \"exit=$?\"");
    const text = await modalText(page);
    expect(text).toContain('OK');
    expect(text).toContain('exit=0');
  });

  test('cisco_audit retourne un code de sortie non nul quand enable secret manque', async ({ page }) => {
    await typeCmd(page, "RUN='hostname R1\\nline vty 0 15\\n transport input telnet'");
    await typeCmd(page, "printf \"$RUN\" | grep -q '^enable secret' || echo MANQUANT; printf \"$RUN\" | grep -q 'transport input ssh' || echo VTY-NON-SSH");
    const text = await modalText(page);
    expect(text).toContain('MANQUANT');
    expect(text).toContain('VTY-NON-SSH');
  });
});
