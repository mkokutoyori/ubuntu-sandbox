import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 7 (e2e) — réplication AD entre DC01 et DC02, depuis les
 * terminaux UI réels de deux contrôleurs de domaine câblés sur un même
 * LAN.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

interface StoreState {
  addDevice(type: string, x: number, y: number): { id: string };
  deviceInstances: Map<string, Record<string, unknown>>;
  addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
}

async function setupTwoDcs(page: Page): Promise<{ dc1Id: string; dc2Id: string }> {
  return page.evaluate(async () => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const dc1 = store.getState().addDevice('windows-server', 200, 200);
    const dc2 = store.getState().addDevice('windows-server', 500, 200);
    const dc1Inst = store.getState().deviceInstances.get(dc1.id) as Record<string, unknown>;
    const dc2Inst = store.getState().deviceInstances.get(dc2.id) as Record<string, unknown>;
    // The scenario's commands target DC01/DC02 by name (-Server, -Identity)
    // — match the device's real hostname to that, instead of the
    // auto-generated "WinServer1/2" default.
    (dc1Inst.setName as (n: string) => void).call(dc1Inst, 'DC01');
    (dc1Inst.setHostname as (n: string) => void).call(dc1Inst, 'DC01');
    (dc2Inst.setName as (n: string) => void).call(dc2Inst, 'DC02');
    (dc2Inst.setHostname as (n: string) => void).call(dc2Inst, 'DC02');
    const p1 = (dc1Inst.getPortNames as () => string[])()[0];
    const p2 = (dc2Inst.getPortNames as () => string[])()[0];
    const exec1 = dc1Inst.executeCommand as (c: string) => Promise<string> | string;
    const exec2 = dc2Inst.executeCommand as (c: string) => Promise<string> | string;
    await Promise.resolve(exec1.call(dc1Inst, `netsh interface ip set address name="${p1}" static 192.168.10.10 255.255.255.0`));
    await Promise.resolve(exec2.call(dc2Inst, `netsh interface ip set address name="${p2}" static 192.168.10.11 255.255.255.0`));
    store.getState().addConnection(dc1.id, p1, dc2.id, p2, 'ethernet');
    return { dc1Id: dc1.id, dc2Id: dc2.id };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  // Once any terminal is open the app covers the canvas with a fixed
  // full-screen overlay, so a device already behind it can't be
  // double-clicked. Peek at the topology first (a real toggle the app
  // provides for exactly this) — opening the new terminal then
  // automatically brings the overlay back showing that device's session.
  const desktopToggle = page.getByTitle('Show topology (terminals stay open)');
  if (await desktopToggle.count() > 0) {
    await desktopToggle.click();
    await page.waitForTimeout(150);
  }
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.waitForTimeout(400);
}
async function typeCmdIn(page: Page, deviceId: string, command: string): Promise<void> {
  const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`).first();
  const target = (await modal.count()) > 0 ? modal : page.locator('[data-testid="terminal-modal"]').last();
  const input = target.locator('input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}
async function modalTextFor(page: Page, deviceId: string): Promise<string> {
  const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`).first();
  const target = (await modal.count()) > 0 ? modal : page.locator('[data-testid="terminal-modal"]').last();
  return target.innerText();
}

test.describe('Scénario 7 (e2e) — réplication AD entre DC01 et DC02', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('Install-ADDSDomainController promeut DC02 ; Get-ADDomainController -Filter * liste les deux DC', async ({ page }) => {
    const { dc1Id, dc2Id } = await setupTwoDcs(page);

    await openTerminal(page, dc1Id);
    await typeCmdIn(page, dc1Id, 'powershell');
    await typeCmdIn(page, dc1Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmdIn(page, dc1Id, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);

    await openTerminal(page, dc2Id);
    await typeCmdIn(page, dc2Id, 'powershell');
    await typeCmdIn(page, dc2Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await typeCmdIn(page, dc2Id, 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);
    await typeCmdIn(page, dc2Id, 'Get-ADDomainController -Filter *');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc2Id);
    expect(text).toContain('DC01');
    expect(text).toContain('DC02');
  });

  test('repadmin /replsummary affiche Fails = 0 après réplication réussie', async ({ page }) => {
    const { dc1Id, dc2Id } = await setupTwoDcs(page);

    await openTerminal(page, dc1Id);
    await typeCmdIn(page, dc1Id, 'powershell');
    await typeCmdIn(page, dc1Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmdIn(page, dc1Id, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);

    await openTerminal(page, dc2Id);
    await typeCmdIn(page, dc2Id, 'powershell');
    await typeCmdIn(page, dc2Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await typeCmdIn(page, dc2Id, 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);

    await typeCmdIn(page, dc1Id, 'cmd');
    await typeCmdIn(page, dc1Id, 'repadmin /replsummary');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc1Id);
    expect(text).toMatch(/Fails\s*0/);
  });

  test('un utilisateur créé sur DC01 est visible sur DC02 après repadmin /syncall DC01 /AdeP', async ({ page }) => {
    const { dc1Id, dc2Id } = await setupTwoDcs(page);

    await openTerminal(page, dc1Id);
    await typeCmdIn(page, dc1Id, 'powershell');
    await typeCmdIn(page, dc1Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmdIn(page, dc1Id, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await typeCmdIn(page, dc1Id, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
    await typeCmdIn(page, dc1Id, 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
    await page.waitForTimeout(500);

    await openTerminal(page, dc2Id);
    await typeCmdIn(page, dc2Id, 'powershell');
    await typeCmdIn(page, dc2Id, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await typeCmdIn(page, dc2Id, 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);

    await typeCmdIn(page, dc1Id, 'New-ADUser -Name "Test-Replication" -SamAccountName "test-repl" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $false -Server "DC01.mandeng.lan"');
    await typeCmdIn(page, dc1Id, 'cmd');
    await typeCmdIn(page, dc1Id, 'repadmin /syncall DC01 /AdeP');
    await page.waitForTimeout(500);

    await typeCmdIn(page, dc2Id, 'Get-ADUser "test-repl" -Server "DC02.mandeng.lan" -ErrorAction SilentlyContinue');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc2Id);
    expect(text).toContain('test-repl');
  });
});
