import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 5 (e2e) — Kerberos : flux AS/TGS lors d'une connexion domaine,
 * inspection via klist et audit des EventIDs de sécurité, depuis les
 * terminaux UI réels d'un contrôleur de domaine et d'un poste client.
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
    await Promise.resolve(execClient.call(clientInst, `netsh interface ip set dns name="${pClient}" static 192.168.10.10`));
    store.getState().addConnection(dc.id, pDc, client.id, pClient, 'ethernet');
    return { dcId: dc.id, clientId: client.id };
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
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
async function typePasswordIn(page: Page, deviceId: string, password: string): Promise<void> {
  const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`).first();
  const target = (await modal.count()) > 0 ? modal : page.locator('[data-testid="terminal-modal"]').last();
  const input = target.locator('input[type="password"]').last();
  await input.focus();
  await input.fill(password);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function promoteAndCreateUser(page: Page, dcId: string): Promise<void> {
  await openTerminal(page, dcId);
  await typeCmdIn(page, dcId, 'powershell');
  await typeCmdIn(page, dcId, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await typeCmdIn(page, dcId, 'Install-WindowsFeature DNS');
  await typeCmdIn(page, dcId, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await typeCmdIn(page, dcId, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
  await page.waitForTimeout(500);
}

test.describe('Scénario 5 (e2e) — Kerberos : tickets, authentification et audit', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('après connexion domaine, klist affiche le TGT krbtgt/MANDENG.LAN de jadmin', async ({ page }) => {
    const { dcId, clientId } = await setupDcAndClient(page);
    await promoteAndCreateUser(page, dcId);

    await openTerminal(page, clientId);
    await typeCmdIn(page, clientId, 'powershell');
    await typeCmdIn(page, clientId, 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Force');
    await page.waitForTimeout(500);
    await typeCmdIn(page, clientId, 'cmd');

    // logon domaine (déclenche l'échange Kerberos AS réel côté simulateur)
    await typeCmdIn(page, clientId, 'runas /user:MANDENG\\jadmin cmd');
    await typePasswordIn(page, clientId, 'User@Mandeng2025!');
    await page.waitForTimeout(300);
    await typeCmdIn(page, clientId, 'klist');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, clientId);
    expect(text).toContain('krbtgt/MANDENG.LAN');
  });

  test('runas avec un mauvais mot de passe échoue avec le message RUNAS ERROR 1326', async ({ page }) => {
    const { dcId, clientId } = await setupDcAndClient(page);
    await promoteAndCreateUser(page, dcId);

    await openTerminal(page, clientId);
    await typeCmdIn(page, clientId, 'powershell');
    await typeCmdIn(page, clientId, 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Force');
    await page.waitForTimeout(500);
    await typeCmdIn(page, clientId, 'cmd');
    await typeCmdIn(page, clientId, 'runas /user:MANDENG\\jadmin cmd');
    await typePasswordIn(page, clientId, 'WrongPassword!');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, clientId);
    expect(text).toMatch(/RUNAS ERROR/i);
    expect(text).toMatch(/1326/);
  });

  test('Get-ADUser svc-oracle -Properties ServicePrincipalNames liste les SPN oracle du compte de service', async ({ page }) => {
    const { dcId } = await setupDcAndClient(page);
    await promoteAndCreateUser(page, dcId);

    await typeCmdIn(page, dcId, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
    await typeCmdIn(page, dcId, 'Set-ADUser -Identity svc-oracle -Add @{ServicePrincipalNames="oracle/srv-oracle.mandeng.lan","oracle/srv-oracle.mandeng.lan:1521"}');
    await typeCmdIn(page, dcId, 'Get-ADUser -Identity "svc-oracle" -Properties ServicePrincipalNames | Select-Object -ExpandProperty ServicePrincipalNames');
    await page.waitForTimeout(300);
    const text = await modalTextFor(page, dcId);
    expect(text).toContain('oracle/srv-oracle.mandeng.lan');
  });
});
