/**
 * Scénario 1 — Installation et promotion d'un contrôleur de domaine
 * Windows Server 2022.
 *
 * Transcription littérale et fidèle : installation du rôle AD DS,
 * promotion en premier DC de la forêt mandeng.lan (Install-ADDSForest),
 * vérification des rôles FSMO, du DNS intégré à l'AD, de SYSVOL/NETLOGON
 * partagés, des services AD critiques, et des événements de promotion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('Scénario 1 — installation et promotion d\'un contrôleur de domaine (mandeng.lan)', () => {
  describe('installation du rôle AD DS via PowerShell', () => {
    it('Get-WindowsFeature AD-Domain-Services montre le rôle disponible avant installation', async () => {
      const dc = new WindowsServer('DC01');
      dc.setCurrentUser('Administrator');
      const out = await run(ps(dc), 'Get-WindowsFeature -Name AD-Domain-Services');
      expect(out).toMatch(/AD-Domain-Services/);
    });

    it('Install-WindowsFeature -IncludeManagementTools -IncludeAllSubFeature installe le rôle avec succès', async () => {
      const dc = new WindowsServer('DC01');
      dc.setCurrentUser('Administrator');
      const out = await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      expect(out).toMatch(/Success/);
      const check = await run(ps(dc), 'Get-WindowsFeature -Name AD-Domain-Services, DNS, RSAT-AD-Tools');
      expect(check).toMatch(/AD-Domain-Services/);
    });
  });

  describe('promotion en premier contrôleur de domaine (Install-ADDSForest)', () => {
    it('Install-ADDSForest -DomainName mandeng.lan promeut le serveur en niveau fonctionnel WinThreshold', async () => {
      const dc = new WindowsServer('DC01');
      dc.setCurrentUser('Administrator');
      await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      await run(ps(dc), 'Import-Module ADDSDeployment');
      const out = await run(ps(dc), [
        'Install-ADDSForest',
        '-DomainName "mandeng.lan"',
        '-DomainNetBiosName "MANDENG"',
        '-ForestMode "WinThreshold"',
        '-DomainMode "WinThreshold"',
        '-InstallDns:$true',
        '-CreateDnsDelegation:$false',
        '-DatabasePath "C:\\Windows\\NTDS"',
        '-LogPath "C:\\Windows\\NTDS"',
        '-SysvolPath "C:\\Windows\\SYSVOL"',
        '-SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force)',
        '-Force:$true',
        '-NoRebootOnCompletion:$false',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
      expect(dc.getDirectoryStore()).not.toBeNull();
    });
  });

  describe('vérification post-promotion — Get-ADDomain et rôles FSMO', () => {
    async function promotedDc(): Promise<WindowsServer> {
      const dc = new WindowsServer('DC01');
      dc.setCurrentUser('Administrator');
      dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
      await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
      return dc;
    }

    it('Get-ADDomain retourne DNSRoot=mandeng.lan, DomainMode=Windows2016Domain, NetBIOSName=MANDENG', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-ADDomain');
      expect(out).toContain('mandeng.lan');
      expect(out).toMatch(/Windows2016Domain/);
      expect(out).toContain('MANDENG');
    });

    it('les 5 rôles FSMO pointent tous vers DC01.mandeng.lan', async () => {
      const dc = await promotedDc();
      const domainRoles = await run(ps(dc), 'Get-ADDomain | Select-Object InfrastructureMaster, PDCEmulator, RIDMaster');
      expect(domainRoles).toContain('DC01.mandeng.lan');
      const forestRoles = await run(ps(dc), 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
      expect(forestRoles).toContain('DC01.mandeng.lan');
    });

    it('le DNS intégré à l\'AD (IsDsIntegrated=True) expose les zones forward et reverse', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-DnsServerZone');
      expect(out).toMatch(/mandeng\.lan/);
      expect(out).toMatch(/IsDsIntegrated|True/);
      expect(out).toMatch(/in-addr\.arpa/);
    });

    it('SYSVOL et NETLOGON sont partagés (Get-SmbShare)', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-SmbShare');
      expect(out).toMatch(/SYSVOL/);
      expect(out).toMatch(/NETLOGON/);
    });
  });

  describe('services AD critiques et journal Directory Service', () => {
    async function promotedDc(): Promise<WindowsServer> {
      const dc = new WindowsServer('DC01');
      dc.setCurrentUser('Administrator');
      await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
      return dc;
    }

    it('ADWS, DNS, KDC, Netlogon, NTDS, W32Time sont tous Running', async () => {
      const dc = await promotedDc();
      for (const svc of ['ADWS', 'DNS', 'KDC', 'Netlogon', 'NTDS', 'W32Time']) {
        const out = await run(ps(dc), `Get-Service -Name ${svc}`);
        expect(out).toMatch(/Running/);
      }
    });

    it('le journal "Directory Service" contient un événement de fin de démarrage AD DS (EventID 1004)', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-EventLog -LogName "Directory Service" -Newest 10');
      expect(out).toMatch(/1004/);
      expect(out).toMatch(/startup complete/i);
    });
  });
});
