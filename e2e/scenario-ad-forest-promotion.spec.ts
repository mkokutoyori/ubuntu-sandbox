import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 1 (e2e) — installation et promotion d'un contrôleur de
 * domaine Windows Server 2022 (mandeng.lan), depuis le terminal UI réel
 * d'un Windows Server.
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
async function enterPowerShell(page: Page): Promise<void> {
  await typeCmd(page, 'powershell');
  await page.waitForTimeout(400);
}

test.describe('Scénario 1 (e2e) — promotion d\'un DC mandeng.lan', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'windows-server');
    await openTerminal(page, id);
    await enterPowerShell(page);
  });

  test('Install-WindowsFeature AD-Domain-Services puis Install-ADDSForest promeut le serveur', async ({ page }) => {
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await page.waitForTimeout(400);
    let text = await modalText(page);
    expect(text).toMatch(/Success/);

    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(600);
    text = await modalText(page);
    expect(text).not.toMatch(/not recognized/i);
  });

  test('après promotion, Get-ADDomain reflète mandeng.lan / MANDENG', async ({ page }) => {
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(600);
    await typeCmd(page, 'Get-ADDomain');
    await page.waitForTimeout(400);
    const text = await modalText(page);
    expect(text).toContain('mandeng.lan');
    expect(text).toContain('MANDENG');
  });

  test('les services AD (ADWS, DNS, KDC, Netlogon, NTDS, W32Time) sont Running après promotion', async ({ page }) => {
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(600);
    for (const svc of ['ADWS', 'DNS', 'KDC', 'Netlogon', 'NTDS', 'W32Time']) {
      await typeCmd(page, `Get-Service -Name ${svc}`);
      await page.waitForTimeout(250);
      const text = await modalText(page);
      expect(text).toMatch(/Running/);
    }
  });
});
