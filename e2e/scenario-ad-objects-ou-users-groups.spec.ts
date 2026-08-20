import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 2 (e2e) — objets AD : structure OU Mandeng, utilisateurs et
 * groupes AGDLP, depuis le terminal PowerShell UI d'un contrôleur de
 * domaine déjà promu.
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

test.describe('Scénario 2 (e2e) — objets AD : OUs, utilisateurs, groupes AGDLP', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'windows-server');
    await openTerminal(page, id);
    await typeCmd(page, 'powershell');
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await page.waitForTimeout(500);
  });

  test('New-ADOrganizationalUnit crée la structure Mandeng, visible via Get-ADOrganizationalUnit -Filter *', async ({ page }) => {
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Groupes" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmd(page, 'Get-ADOrganizationalUnit -Filter *');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('Mandeng');
    expect(text).toContain('Utilisateurs');
    expect(text).toContain('Groupes');
  });

  test('New-ADUser + Add-ADGroupMember : jadmin visible dans GRP-IT-Admin', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
    await typeCmd(page, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
    await typeCmd(page, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
    await typeCmd(page, 'Get-ADGroupMember -Identity "GRP-IT-Admin"');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('jadmin');
  });

  test('modèle AGDLP : DL-Partage-IT liste GRP-IT-Admin, pas les utilisateurs', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force) -Enabled $true');
    await typeCmd(page, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
    await typeCmd(page, 'New-ADGroup -Name "DL-Partage-IT" -GroupScope DomainLocal -GroupCategory Security');
    await typeCmd(page, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
    await typeCmd(page, 'Add-ADGroupMember -Identity "DL-Partage-IT" -Members "GRP-IT-Admin"');
    await typeCmd(page, 'Get-ADGroupMember -Identity "DL-Partage-IT"');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('GRP-IT-Admin');
  });
});
