/**
 * Scénario 16 — Trust Relationships : approbation entre domaines
 * (mandeng.lan ↔ partenaire.local).
 *
 * Transcription littérale et fidèle, avec les cmdlets réellement
 * implémentées par ce simulateur (PRD-Windows-Server-Advanced.md §5 P9)
 * — `New-ADTrust`/`Get-ADTrust`, pas `Add-ADTrust` (qui n'est d'ailleurs
 * pas un vrai cmdlet PowerShell) : établissement d'une approbation
 * bidirectionnelle entre mandeng.lan et partenaire.local, vérification
 * via `Get-ADTrust`/`netdom trust ... /verify`, ajout d'un utilisateur
 * du domaine partenaire à un groupe local Mandeng (ForeignSecurityPrincipal),
 * authentification Kerberos inter-domaines via `runas`, et audit de
 * l'EventID 4769 avec `TargetDomainName = PARTENAIRE`.
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

async function buildTwoDomainsAndClient(): Promise<{ dc: WindowsServer; dcPartenaire: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const dcPartenaire = new WindowsServer('DC-PARTENAIRE');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-partenaire').connect(dcPartenaire.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  dcPartenaire.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Groupes" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADGroup -Name "DL-Partage-IT" -Path "OU=Groupes,OU=Mandeng,DC=mandeng,DC=lan" -GroupScope DomainLocal -GroupCategory Security');

  dcPartenaire.setCurrentUser('Administrator');
  await run(ps(dcPartenaire), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dcPartenaire), 'Install-ADDSForest -DomainName "partenaire.local" -DomainNetBiosName "PARTENAIRE" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Partenaire2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dcPartenaire), 'New-ADUser -Name "Utilisateur Partenaire" -SamAccountName "user-partenaire" -AccountPassword (ConvertTo-SecureString "Partner@2025!" -AsPlainText -Force) -Enabled $true');

  client.setCurrentUser('Administrator');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Server 192.168.10.10 -Force');

  return { dc, dcPartenaire, client };
}

describe('Scénario 16 — trust relationships entre mandeng.lan et partenaire.local', () => {
  describe('établissement de l\'approbation', () => {
    it('Test-NetConnection vers DC-PARTENAIRE.partenaire.local sur le port 389 (LDAP) réussit', async () => {
      const { dc } = await buildTwoDomainsAndClient();
      const out = await run(ps(dc), 'Test-NetConnection -ComputerName "192.168.10.20" -Port 389');
      expect(out).toMatch(/TcpTestSucceeded\s*:\s*True/);
    });

    it('New-ADTrust établit une approbation bidirectionnelle depuis mandeng.lan vers partenaire.local', async () => {
      const { dc } = await buildTwoDomainsAndClient();
      const out = await run(ps(dc), 'New-ADTrust -Target "partenaire.local" -Direction Bidirectional -Credential "Administrator:DSRM@Partenaire2025!" -Server "192.168.10.20"');
      expect(out).not.toMatch(/ERROR/i);
    });
  });

  describe('vérification de l\'approbation', () => {
    async function labWithTrust(): Promise<{ dc: WindowsServer; dcPartenaire: WindowsServer; client: WindowsPC }> {
      const lab = await buildTwoDomainsAndClient();
      await run(ps(lab.dc), 'New-ADTrust -Target "partenaire.local" -Direction Bidirectional -Credential "Administrator:DSRM@Partenaire2025!" -Server "192.168.10.20"');
      return lab;
    }

    it('Get-ADTrust -Filter * liste l\'approbation avec Direction=Bidirectional et Target=partenaire.local', async () => {
      const { dc } = await labWithTrust();
      const out = await run(ps(dc), 'Get-ADTrust -Filter *');
      expect(out).toContain('partenaire.local');
      expect(out).toContain('Bidirectional');
    });

    it('le côté partenaire.local voit le miroir de l\'approbation vers mandeng.lan', async () => {
      const { dcPartenaire } = await labWithTrust();
      const out = await run(ps(dcPartenaire), 'Get-ADTrust -Identity "mandeng.lan"');
      expect(out).toMatch(/mandeng\.lan/i);
      expect(out).toContain('Bidirectional');
    });

    it('netdom trust mandeng.lan /domain:partenaire.local /verify confirme le canal sécurisé', async () => {
      const { dc } = await labWithTrust();
      const out = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /verify');
      expect(out).toMatch(/command completed successfully/i);
    });

    it('une authentification runas d\'un utilisateur partenaire.local depuis un poste mandeng.lan réussit via le trust (TGT cross-domain)', async () => {
      const { client } = await labWithTrust();
      const sh = ps(client);
      await run(sh, 'cmd');
      const out = await run(sh, 'runas /user:partenaire.local\\user-partenaire whoami');
      expect(out).not.toMatch(/RUNAS ERROR/i);
    });
  });

  describe('netdom trust /Remove et /Reset (docs/PRD-Netdom.md §2.1 P9)', () => {
    async function labWithTrust(): Promise<{ dc: WindowsServer; dcPartenaire: WindowsServer; client: WindowsPC }> {
      const lab = await buildTwoDomainsAndClient();
      await run(ps(lab.dc), 'New-ADTrust -Target "partenaire.local" -Direction Bidirectional -Credential "Administrator:DSRM@Partenaire2025!" -Server "192.168.10.20"');
      return lab;
    }

    it('netdom trust .../Remove removes the trust on both sides when the remote is reachable', async () => {
      const { dc, dcPartenaire } = await labWithTrust();
      const out = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /remove /Server:192.168.10.20 /UserD:Administrator /PasswordD:DSRM@Partenaire2025!');
      expect(out).toMatch(/command completed successfully/i);
      expect(dc.getDirectoryStore()!.getTrust('partenaire.local')).toBeNull();
      expect(dcPartenaire.getDirectoryStore()!.getTrust('mandeng.lan')).toBeNull();
    });

    it('netdom trust .../Remove still removes locally when the remote is unreachable', async () => {
      const lab = await labWithTrust();
      const out = await lab.dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /remove /Server:192.168.10.20 /UserD:Administrator /PasswordD:wrongpassword');
      expect(out).toMatch(/command completed successfully/i);
      expect(lab.dc.getDirectoryStore()!.getTrust('partenaire.local')).toBeNull();
    });

    it('netdom trust .../Remove fails cleanly when no such trust exists', async () => {
      const { dc } = await buildTwoDomainsAndClient();
      const out = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /remove');
      expect(out).toMatch(/failed to complete successfully/i);
    });

    it('netdom trust .../Reset regenerates the interrealm key on both sides, and the trust still verifies afterwards', async () => {
      const { dc, dcPartenaire } = await labWithTrust();
      const before = dc.getDirectoryStore()!.getTrust('partenaire.local')!.interrealmKey;
      const out = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /reset /Server:192.168.10.20 /UserD:Administrator /PasswordD:DSRM@Partenaire2025!');
      expect(out).toMatch(/command completed successfully/i);
      const after = dc.getDirectoryStore()!.getTrust('partenaire.local')!.interrealmKey;
      expect(after).not.toBe(before);
      expect(dcPartenaire.getDirectoryStore()!.getTrust('mandeng.lan')!.interrealmKey).toBe(after);
      const verify = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /verify');
      expect(verify).toMatch(/command completed successfully/i);
    });

    it('netdom trust /Force is accepted without error but has no additional observable effect', async () => {
      const { dc } = await labWithTrust();
      const out = await dc.executeCmdCommand('netdom trust mandeng.lan /domain:partenaire.local /remove /Force');
      expect(out).toMatch(/command completed successfully/i);
    });
  });

  describe('accès aux ressources cross-domaine', () => {
    async function labWithTrustAndGroup(): Promise<{ dc: WindowsServer }> {
      const { dc, dcPartenaire, client } = await buildTwoDomainsAndClient();
      await run(ps(dc), 'New-ADTrust -Target "partenaire.local" -Direction Bidirectional -Credential "Administrator:DSRM@Partenaire2025!" -Server "192.168.10.20"');
      void dcPartenaire;
      void client;
      return { dc };
    }

    it('Add-ADGroupMember ajoute partenaire.local\\user-partenaire au groupe local DL-Partage-IT', async () => {
      const { dc } = await labWithTrustAndGroup();
      const out = await run(ps(dc), 'Add-ADGroupMember -Identity "DL-Partage-IT" -Members "partenaire.local\\user-partenaire"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Get-ADGroupMember DL-Partage-IT liste le compte externe comme ForeignSecurityPrincipal', async () => {
      const { dc } = await labWithTrustAndGroup();
      const sh = ps(dc);
      await run(sh, 'Add-ADGroupMember -Identity "DL-Partage-IT" -Members "partenaire.local\\user-partenaire"');

      const out = await run(sh, 'Get-ADGroupMember "DL-Partage-IT" | Where-Object {$_.objectClass -eq "foreignSecurityPrincipal"} | Select-Object Name, DistinguishedName');
      expect(out).toMatch(/user-partenaire/i);
      expect(out).toMatch(/foreignSecurityPrincipal|ForeignSecurityPrincipals/i);
    });

    it('l\'authentification cross-domaine de user-partenaire génère un EventID 4769 avec TargetDomainName = PARTENAIRE sur DC01', async () => {
      const { dc } = await buildTwoDomainsAndClient().then(async (lab) => {
        await run(ps(lab.dc), 'New-ADTrust -Target "partenaire.local" -Direction Bidirectional -Credential "Administrator:DSRM@Partenaire2025!" -Server "192.168.10.20"');
        const clientSh = ps(lab.client);
        await run(clientSh, 'cmd');
        await run(clientSh, 'runas /user:partenaire.local\\user-partenaire whoami');
        return lab;
      });

      const out = await run(ps(dc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4769; StartTime = (Get-Date).AddMinutes(-10) }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $target = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetDomainName\'} | Select-Object -ExpandProperty \'#text\'',
        '  if ($target -eq "PARTENAIRE") { [PSCustomObject]@{ Heure = $_.TimeCreated; EventID = $_.Id; DomaineSrc = $target } }',
        '} | Format-Table -AutoSize',
      ].join('\n'));
      expect(out).toMatch(/4769/);
      expect(out).toMatch(/PARTENAIRE/);
    });
  });
});
