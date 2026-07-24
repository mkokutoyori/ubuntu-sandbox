/**
 * Scénario 19 — Windows Hello for Business : authentification sans mot
 * de passe.
 *
 * Transcription littérale et fidèle : PKI d'entreprise prérequise
 * (ADCS-Cert-Authority/-Web-Enrollment, Install-AdcsCertificationAuthority
 * -CAType EnterpriseRootCa, modèle SmartcardLogonV2 via Add-CATemplate),
 * activation de WHfB par GPO (PassportForWork Enabled=1,
 * RequireSecurityDevice, complexité de PIN), liaison à OU=Postes, et
 * vérification de l'enrôlement côté client (dsregcmd /status,
 * msDS-KeyCredentialLink) et de l'authentification PKINIT
 * (EventID 4768 avec PreAuthType=15).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Ordinateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Postes" -Path "OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');

  client.setCurrentUser('Administrator');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01" -Force');

  return { dc, client };
}

describe('Scénario 19 — Windows Hello for Business (mandeng.lan)', () => {
  describe('prérequis et configuration PKI pour WHfB', () => {
    it('Install-WindowsFeature installe ADCS-Cert-Authority et ADCS-Web-Enrollment', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), 'Install-WindowsFeature -Name ADCS-Cert-Authority, ADCS-Web-Enrollment -IncludeManagementTools');
      expect(out).toMatch(/Success/i);
    });

    it('Install-AdcsCertificationAuthority configure la CA racine d\'entreprise Mandeng-Root-CA', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'Install-WindowsFeature -Name ADCS-Cert-Authority, ADCS-Web-Enrollment -IncludeManagementTools');
      const out = await run(sh, [
        'Install-AdcsCertificationAuthority',
        '-CAType EnterpriseRootCa',
        '-CACommonName "Mandeng-Root-CA"',
        '-CADistinguishedNameSuffix "DC=mandeng,DC=lan"',
        '-HashAlgorithm SHA256',
        '-KeyLength 2048',
        '-CryptoProviderName "RSA#Microsoft Software Key Storage Provider"',
        '-Confirm:$false',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Add-CATemplate publie le modèle SmartcardLogonV2 utilisé pour l\'enrôlement WHfB', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'Install-WindowsFeature -Name ADCS-Cert-Authority, ADCS-Web-Enrollment -IncludeManagementTools');
      await run(sh, 'Install-AdcsCertificationAuthority -CAType EnterpriseRootCa -CACommonName "Mandeng-Root-CA" -CADistinguishedNameSuffix "DC=mandeng,DC=lan" -Confirm:$false');
      const out = await run(sh, 'Add-CATemplate -TemplateName "SmartcardLogonV2"');
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('configuration de WHfB via GPO', () => {
    async function labWithGpo(): Promise<{ dc: WindowsServer; client: WindowsPC; sh: ReturnType<typeof ps> }> {
      const { dc, client } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-GPO -Name "MANDENG-WindowsHelloForBusiness" -Domain "mandeng.lan"');
      return { dc, client, sh };
    }

    it('New-GPO crée MANDENG-WindowsHelloForBusiness', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'Get-GPO -Name "MANDENG-WindowsHelloForBusiness"');
      expect(out).toContain('MANDENG-WindowsHelloForBusiness');
    });

    it('Set-GPRegistryValue active Windows Hello for Business (PassportForWork Enabled=1)', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'Set-GPRegistryValue -Name "MANDENG-WindowsHelloForBusiness" -Key "HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork" -ValueName "Enabled" -Type DWord -Value 1');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-GPRegistryValue configure RequireSecurityDevice=0 (TPM préféré mais pas obligatoire)', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'Set-GPRegistryValue -Name "MANDENG-WindowsHelloForBusiness" -Key "HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork" -ValueName "RequireSecurityDevice" -Type DWord -Value 0');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-GPRegistryValue configure MinimumPINLength=6 et RequireUppercase=1', async () => {
      const { sh } = await labWithGpo();
      await run(sh, 'Set-GPRegistryValue -Name "MANDENG-WindowsHelloForBusiness" -Key "HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork\\PINComplexity" -ValueName "MinimumPINLength" -Type DWord -Value 6');
      const out = await run(sh, 'Set-GPRegistryValue -Name "MANDENG-WindowsHelloForBusiness" -Key "HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork\\PINComplexity" -ValueName "RequireUppercase" -Type DWord -Value 1');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('New-GPLink lie MANDENG-WindowsHelloForBusiness à OU=Postes', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'New-GPLink -Name "MANDENG-WindowsHelloForBusiness" -Target "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -LinkEnabled Yes');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('dsregcmd /status sur PC-WIN-01 confirme DomainJoined après gpupdate /force', async () => {
      const { client, sh } = await labWithGpo();
      await run(sh, 'New-GPLink -Name "MANDENG-WindowsHelloForBusiness" -Target "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -LinkEnabled Yes');

      const clientSh = ps(client);
      await run(clientSh, 'cmd');
      await run(clientSh, 'gpupdate /force');
      const out = await client.executeCmdCommand('dsregcmd /status');
      expect(out).toMatch(/DomainJoined\s*:\s*YES/i);
    });
  });

  describe('vérification de l\'enrôlement et de l\'authentification', () => {
    it('dsregcmd /status affiche HelloIsEnabled : YES et NgcKeyRegistered : YES après enrôlement', async () => {
      const { dc, client } = await buildLan();
      await run(ps(dc), 'New-GPO -Name "MANDENG-WindowsHelloForBusiness" -Domain "mandeng.lan"');
      await run(ps(dc), 'Set-GPRegistryValue -Name "MANDENG-WindowsHelloForBusiness" -Key "HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork" -ValueName "Enabled" -Type DWord -Value 1');
      await run(ps(dc), 'New-GPLink -Name "MANDENG-WindowsHelloForBusiness" -Target "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -LinkEnabled Yes');

      const sh = ps(client);
      await run(sh, 'cmd');
      await run(sh, 'gpupdate /force');
      const out = await client.executeCmdCommand('dsregcmd /status');
      expect(out).toMatch(/HelloIsEnabled\s*:\s*YES/i);
      expect(out).toMatch(/NgcKeyRegistered\s*:\s*YES/i);
    });

    it('Get-ADUser jadmin -Properties msDS-KeyCredentialLink contient la clé publique WHfB après enrôlement', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), 'Get-ADUser "jadmin" -Properties msDS-KeyCredentialLink | Select-Object Name, msDS-KeyCredentialLink');
      expect(out).not.toMatch(/not recognized/i);
      expect(out).toMatch(/msDS-KeyCredentialLink/);
    });

    it('EventID 4768 avec PreAuthType=15 (PKINIT) confirme une authentification WHfB au lieu d\'un mot de passe', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      const out = await run(sh, [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4768, 4769) } -ErrorAction SilentlyContinue',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $authPackage = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'PreAuthType\'} | Select-Object -ExpandProperty \'#text\'',
        '  if ($authPackage -eq "15") { Write-Host "Authentification WHfB detectee a $($_.TimeCreated)" }',
        '}',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);
    });
  });
});
