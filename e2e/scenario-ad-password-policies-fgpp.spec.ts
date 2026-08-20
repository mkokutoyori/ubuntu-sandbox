import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario 6 (e2e) — politique de mots de passe du domaine et
 * Fine-Grained Password Policy, depuis le terminal PowerShell UI d'un
 * contrôleur de domaine déjà promu.
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

test.describe('Scénario 6 (e2e) — politique de mots de passe et FGPP', () => {
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

  test('Get-ADDefaultDomainPasswordPolicy affiche les valeurs par défaut du domaine', async ({ page }) => {
    await typeCmd(page, 'Get-ADDefaultDomainPasswordPolicy');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toMatch(/MinPasswordLength/);
    expect(text).toMatch(/LockoutThreshold/);
  });

  test('New-ADFineGrainedPasswordPolicy + Add-ADFineGrainedPasswordPolicySubject créent PSO-Administrateurs pour GRP-IT-Admin', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
    await typeCmd(page, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
    await typeCmd(page, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
    await typeCmd(page, 'New-ADFineGrainedPasswordPolicy -Name "PSO-Administrateurs" -Precedence 10 -MinPasswordLength 16 -MaxPasswordAge (New-TimeSpan -Days 60) -ComplexityEnabled $true');
    await typeCmd(page, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-Administrateurs" -Subjects "GRP-IT-Admin"');
    await typeCmd(page, 'Get-ADUserResultantPasswordPolicy -Identity "jadmin"');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('PSO-Administrateurs');
  });

  test('la PSO de plus basse Precedence l\'emporte quand un compte est sujet de deux PSO', async ({ page }) => {
    await typeCmd(page, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
    await typeCmd(page, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
    await typeCmd(page, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members svc-oracle');
    await typeCmd(page, 'New-ADFineGrainedPasswordPolicy -Name "PSO-Administrateurs" -Precedence 10 -MinPasswordLength 16 -ComplexityEnabled $true');
    await typeCmd(page, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-Administrateurs" -Subjects "GRP-IT-Admin"');
    await typeCmd(page, 'New-ADFineGrainedPasswordPolicy -Name "PSO-ServiceAccounts" -Precedence 5 -MinPasswordLength 24 -MaxPasswordAge (New-TimeSpan -Days 0) -LockoutThreshold 0 -ComplexityEnabled $true');
    await typeCmd(page, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts" -Subjects "svc-oracle"');
    await typeCmd(page, 'Get-ADUserResultantPasswordPolicy -Identity "svc-oracle"');
    await page.waitForTimeout(300);
    const text = await modalText(page);
    expect(text).toContain('PSO-ServiceAccounts');
  });
});
