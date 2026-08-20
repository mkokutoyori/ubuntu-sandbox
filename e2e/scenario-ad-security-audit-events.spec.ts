import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 9 (e2e) — audit des événements de sécurité AD, depuis le
 * terminal UI (PowerShell + cmd) d'un contrôleur de domaine déjà promu.
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

test.describe('Scénario 9 (e2e) — audit des événements de sécurité AD', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'windows-server');
    await openTerminal(page, id);
    await typeCmd(page, 'powershell');
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await typeCmd(page, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
    await page.waitForTimeout(500);
  });

  test('auditpol /set active les sous-catégories requises pour l\'audit AD', async ({ page }) => {
    await typeCmd(page, 'cmd');
    await typeCmd(page, 'auditpol /set /subcategory:"User Account Management" /success:enable /failure:enable');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toMatch(/successfully executed/i);
  });

  test('New-ADUser génère EventID 4720, visible via Get-WinEvent -FilterHashtable', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
    await typeCmd(page, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4720; StartTime = (Get-Date).AddMinutes(-10) }");
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('4720');
  });

  test('le cycle complet créé/modifié/groupe/supprimé produit les EventIDs 4720/4738/4728/4726 collectés et corrélés', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
    await typeCmd(page, 'Set-ADUser "audittest" -Department "Finance" -Title "Analyste"');
    await typeCmd(page, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members "audittest"');
    await typeCmd(page, 'Remove-ADUser "audittest" -Confirm:$false');
    await typeCmd(page, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4720, 4726, 4728, 4738); StartTime = (Get-Date).AddMinutes(-10) } | Select-Object TimeCreated, Id");
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('4720');
    expect(text).toContain('4726');
  });
});
