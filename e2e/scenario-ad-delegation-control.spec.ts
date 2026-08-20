import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 8 (e2e) — délégation de contrôle sur des OUs, depuis le
 * terminal PowerShell UI d'un contrôleur de domaine déjà promu avec sa
 * structure d'OUs.
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

test.describe('Scénario 8 (e2e) — délégation de contrôle sur des OUs', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'windows-server');
    await openTerminal(page, id);
    await typeCmd(page, 'powershell');
    await typeCmd(page, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await typeCmd(page, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Reseau" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADOrganizationalUnit -Name "Administration" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
    await typeCmd(page, 'New-ADUser -Name "Pierre Reseau" -SamAccountName preseau -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
    await page.waitForTimeout(500);
  });

  test('Set-ACL délègue CreateChild/WriteProperty/DeleteChild à preseau sur OU=Reseau', async ({ page }) => {
    const OUReseau = 'OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';
    await typeCmd(page, '$UserPreseau = Get-ADUser "preseau"');
    await typeCmd(page, '$UserSID = [System.Security.Principal.SecurityIdentifier]$UserPreseau.SID');
    await typeCmd(page, `$ADOU = Get-ADOrganizationalUnit "${OUReseau}"`);
    await typeCmd(page, '$Path = "AD:\\$($ADOU.DistinguishedName)"');
    await typeCmd(page, '$ACL = Get-ACL -Path $Path');
    await typeCmd(page, '$ACE_Create = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "CreateChild", "Allow", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2", "None", [GUID]::Empty)');
    await typeCmd(page, '$ACL.AddAccessRule($ACE_Create)');
    await typeCmd(page, 'Set-ACL -Path $Path -AclObject $ACL');
    await typeCmd(page, `(Get-ACL -Path "AD:\\${OUReseau}").Access | Where-Object {$_.IdentityReference -like "*preseau*"}`);
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('preseau');
  });

  test('preseau peut créer un utilisateur dans OU=Reseau mais reçoit "Access is denied" dans OU=Administration', async ({ page }) => {
    await typeCmd(page, '$Cred = "preseau:User@Mandeng2025!"');
    await typeCmd(page, 'New-ADUser -Name "Test Delegation" -SamAccountName "test-deleg" -Path "OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $false -Credential $Cred -Server "DC01.mandeng.lan"');
    await typeCmd(page, 'Get-ADUser "test-deleg"');
    await page.waitForTimeout(300);
    let text = await modalText(page);
    expect(text).toContain('test-deleg');

    await typeCmd(page, 'New-ADUser -Name "Test Hors Perimetre" -SamAccountName "test-hors" -Path "OU=Administration,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $false -Credential $Cred');
    await page.waitForTimeout(300);
    text = await modalText(page);
    expect(text).toMatch(/Access is denied/i);
  });
});
