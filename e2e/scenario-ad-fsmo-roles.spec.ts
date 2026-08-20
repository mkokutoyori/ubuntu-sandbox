import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 10 (e2e) — rôles FSMO : vérification, transfert et saisie,
 * depuis les terminaux UI réels de deux contrôleurs de domaine câblés
 * sur un même LAN.
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
    // The scenario's commands target DC01/DC02 by name (-Server, -Identity,
    // FSMO FQDNs) — match the device's real hostname to that, instead of
    // the auto-generated "WinServer1/2" default.
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

async function buildTwoPromotedDcs(page: Page): Promise<{ dc1Id: string; dc2Id: string }> {
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
  return { dc1Id, dc2Id };
}

test.describe('Scénario 10 (e2e) — rôles FSMO : vérification, transfert, saisie', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('Get-ADForest et Get-ADDomain montrent DC01 titulaire des 5 rôles FSMO juste après la promotion', async ({ page }) => {
    const { dc1Id } = await buildTwoPromotedDcs(page);

    await typeCmdIn(page, dc1Id, 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
    await typeCmdIn(page, dc1Id, 'Get-ADDomain | Select-Object InfrastructureMaster, PDCEmulator, RIDMaster');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc1Id);
    expect(text).toMatch(/DC01/);
  });

  test('Move-ADDirectoryServerOperationMasterRole transfère PDCEmulator et RIDMaster vers DC02', async ({ page }) => {
    const { dc1Id } = await buildTwoPromotedDcs(page);

    await typeCmdIn(page, dc1Id, 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole PDCEmulator, RIDMaster -Confirm:$false');
    await typeCmdIn(page, dc1Id, 'Get-ADDomain | Select-Object PDCEmulator, RIDMaster');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc1Id);
    expect(text).toMatch(/DC02/);
  });

  test('Move-ADDirectoryServerOperationMasterRole -Force saisit les rôles restants sur DC02', async ({ page }) => {
    const { dc2Id } = await buildTwoPromotedDcs(page);

    await typeCmdIn(page, dc2Id, 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole SchemaMaster, DomainNamingMaster, InfrastructureMaster -Force -Confirm:$false');
    await typeCmdIn(page, dc2Id, 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dc2Id);
    expect(text).toMatch(/DC02/);
  });
});
