import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 3 (e2e) — jonction d'un poste Windows au domaine mandeng.lan
 * et vérification du compte machine, depuis les terminaux UI réels d'un
 * contrôleur de domaine et d'un poste client, câblés sur un même LAN.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

interface StoreState {
  addDevice(type: string, x: number, y: number): { id: string };
  deviceInstances: Map<string, Record<string, unknown>>;
  addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
}

async function setupDcAndClient(page: Page): Promise<{ dcId: string; clientId: string }> {
  return page.evaluate(async () => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const dc = store.getState().addDevice('windows-server', 200, 200);
    const client = store.getState().addDevice('windows-pc', 500, 200);
    const dcInst = store.getState().deviceInstances.get(dc.id) as Record<string, unknown>;
    const clientInst = store.getState().deviceInstances.get(client.id) as Record<string, unknown>;
    const dcPorts = (dcInst.getPortNames as () => string[])();
    const clientPorts = (clientInst.getPortNames as () => string[])();
    const pDc = dcPorts[0];
    const pClient = clientPorts[0];
    const execDc = dcInst.executeCommand as (c: string) => Promise<string> | string;
    const execClient = clientInst.executeCommand as (c: string) => Promise<string> | string;
    await Promise.resolve(execDc.call(dcInst, `netsh interface ip set address name="${pDc}" static 192.168.10.10 255.255.255.0`));
    await Promise.resolve(execClient.call(clientInst, `netsh interface ip set address name="${pClient}" static 192.168.10.30 255.255.255.0`));
    store.getState().addConnection(dc.id, pDc, client.id, pClient, 'ethernet');
    return { dcId: dc.id, clientId: client.id };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
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
async function lastModalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').last().innerText());
}

test.describe('Scénario 3 (e2e) — jonction au domaine et compte machine PC-WIN-01', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('Add-Computer -OUPath joint PC-WIN-01 au domaine ; Get-ADComputer le confirme sous OU=Postes', async ({ page }) => {
    const { dcId, clientId } = await setupDcAndClient(page);

    await openTerminal(page, dcId);
    await typeCmdIn(page, dcId, 'powershell');
    await typeCmdIn(page, dcId, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmdIn(page, dcId, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await typeCmdIn(page, dcId, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
    await typeCmdIn(page, dcId, 'New-ADOrganizationalUnit -Name "Ordinateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmdIn(page, dcId, 'New-ADOrganizationalUnit -Name "Postes" -Path "OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan"');
    await page.waitForTimeout(500);

    await openTerminal(page, clientId);
    await typeCmdIn(page, clientId, 'powershell');
    await typeCmdIn(page, clientId, 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01" -Force');
    await page.waitForTimeout(500);

    await openTerminal(page, dcId);
    await typeCmdIn(page, dcId, 'Get-ADComputer -Filter {Name -eq "PC-WIN-01"} -Properties *');
    await page.waitForTimeout(300);
    const text = await lastModalText(page);
    expect(text).toContain('PC-WIN-01');
    expect(text).toContain('OU=Postes');
  });
});
