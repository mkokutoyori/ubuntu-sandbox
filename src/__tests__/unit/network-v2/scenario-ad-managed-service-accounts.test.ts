/**
 * Scénario 14 — Comptes de service gérés : gMSA et sMSA.
 *
 * Transcription littérale et fidèle : clé racine KDS
 * (Add-KdsRootKey -EffectiveImmediately, prérequis des gMSA), création
 * d'un gMSA multi-machines pour Oracle
 * (PrincipalsAllowedToRetrieveManagedPassword sur SRV-ORACLE/-DR,
 * ManagedPasswordIntervalInDays=30, SPN oracle/...), déploiement
 * (Install-ADServiceAccount/Test-ADServiceAccount) sur SRV-ORACLE, et
 * création d'un sMSA lié à une seule machine (SRV-WEB) via
 * -RestrictToSingleComputer + Add-ADComputerServiceAccount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
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

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; srvOracle: WindowsServer; srvWeb: WindowsServer }> {
  const dc = new WindowsServer('DC01');
  const srvOracle = new WindowsServer('SRV-ORACLE');
  const srvWeb = new WindowsServer('SRV-WEB');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-oracle').connect(srvOracle.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-web').connect(srvWeb.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  srvOracle.getPorts()[0].configureIP(new IPAddress('192.168.10.21'), mask);
  srvWeb.getPorts()[0].configureIP(new IPAddress('192.168.10.22'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "ServiceAccounts" -Path "OU=Mandeng,DC=mandeng,DC=lan"');

  // Add-Computer needs each client's DNS resolver already pointed at the
  // domain (this simulator has no dynamic-DNS registration for a promoted
  // DC yet) — seed the hosts file the same way a real DHCP-assigned DNS
  // server would already know it.
  const hostsEntry = 'Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 mandeng.lan`n192.168.10.10 DC01.mandeng.lan"';
  srvOracle.setCurrentUser('Administrator');
  await run(ps(srvOracle), hostsEntry);
  await run(ps(srvOracle), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "SRV-ORACLE" -Force');
  srvWeb.setCurrentUser('Administrator');
  await run(ps(srvWeb), hostsEntry);
  await run(ps(srvWeb), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "SRV-WEB" -Force');

  return { dc, srvOracle, srvWeb };
}

describe('Scénario 14 — comptes de service gérés : gMSA et sMSA (mandeng.lan)', () => {
  describe('prérequis : clé racine KDS', () => {
    it('Get-KdsRootKey ne retourne rien avant l\'initialisation', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), 'Get-KdsRootKey');
      expect(out.trim()).toBe('');
    });

    it('Add-KdsRootKey -EffectiveImmediately crée la clé racine KDS disponible immédiatement', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      const out = await run(sh, 'Add-KdsRootKey -EffectiveImmediately');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-KdsRootKey');
      expect(check).toMatch(/KeyId/);
      expect(check).toMatch(/EffectiveTime/);
      expect(check).toMatch(/IsEfficientlyDeleted\s*:\s*False/);
    });
  });

  describe('création d\'un gMSA pour Oracle', () => {
    async function labWithKds(): Promise<WindowsServer> {
      const { dc } = await buildLan();
      await run(ps(dc), 'Add-KdsRootKey -EffectiveImmediately');
      return dc;
    }

    it('New-ADServiceAccount crée gMSA-Oracle avec accès depuis SRV-ORACLE$ et SRV-ORACLE-DR$, intervalle de mot de passe 30 jours', async () => {
      const dc = await labWithKds();
      const sh = ps(dc);
      const out = await run(sh, [
        'New-ADServiceAccount',
        '-Name "gMSA-Oracle"',
        '-DNSHostName "gmsa-oracle.mandeng.lan"',
        '-Description "Compte de service gere pour Oracle Database"',
        '-PrincipalsAllowedToRetrieveManagedPassword "SRV-ORACLE$","SRV-ORACLE-DR$"',
        '-ManagedPasswordIntervalInDays 30',
        '-Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADServiceAccount "gMSA-Oracle"');
      expect(check).toContain('gMSA-Oracle');
    });

    it('Set-ADServiceAccount ajoute les 4 SPN Oracle au gMSA', async () => {
      const dc = await labWithKds();
      const sh = ps(dc);
      await run(sh, 'New-ADServiceAccount -Name "gMSA-Oracle" -DNSHostName "gmsa-oracle.mandeng.lan" -PrincipalsAllowedToRetrieveManagedPassword "SRV-ORACLE$" -ManagedPasswordIntervalInDays 30 -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');

      const out = await run(sh, 'Set-ADServiceAccount "gMSA-Oracle" -ServicePrincipalNames @{ Add = @("oracle/srv-oracle.mandeng.lan", "oracle/srv-oracle.mandeng.lan:1521", "oracle/SRV-ORACLE", "oracle/SRV-ORACLE:1521") }');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADServiceAccount "gMSA-Oracle" -Properties ServicePrincipalNames | Select-Object -ExpandProperty ServicePrincipalNames');
      expect(check).toContain('oracle/srv-oracle.mandeng.lan');
      expect(check).toContain('oracle/srv-oracle.mandeng.lan:1521');
      expect(check).toContain('oracle/SRV-ORACLE');
    });

    it('Get-ADServiceAccount -Properties * expose DNSHostName, ManagedPasswordInterval et PrincipalsAllowedToRetrieveManagedPassword', async () => {
      const dc = await labWithKds();
      const sh = ps(dc);
      await run(sh, 'New-ADServiceAccount -Name "gMSA-Oracle" -DNSHostName "gmsa-oracle.mandeng.lan" -PrincipalsAllowedToRetrieveManagedPassword "SRV-ORACLE$","SRV-ORACLE-DR$" -ManagedPasswordIntervalInDays 30 -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');

      const out = await run(sh, 'Get-ADServiceAccount "gMSA-Oracle" -Properties * | Select-Object Name, DNSHostName, ServicePrincipalNames, ManagedPasswordInterval, PrincipalsAllowedToRetrieveManagedPassword | Format-List');
      expect(out).toContain('gmsa-oracle.mandeng.lan');
      expect(out).toMatch(/ManagedPasswordInterval\s*:\s*30/);
      expect(out).toMatch(/SRV-ORACLE\$/);
    });
  });

  describe('déploiement du gMSA sur le serveur Oracle', () => {
    async function labWithGmsa(): Promise<{ dc: WindowsServer; srvOracle: WindowsServer }> {
      const { dc, srvOracle } = await buildLan();
      await run(ps(dc), 'Add-KdsRootKey -EffectiveImmediately');
      await run(ps(dc), 'New-ADServiceAccount -Name "gMSA-Oracle" -DNSHostName "gmsa-oracle.mandeng.lan" -PrincipalsAllowedToRetrieveManagedPassword "SRV-ORACLE$" -ManagedPasswordIntervalInDays 30 -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');
      return { dc, srvOracle };
    }

    it('Install-ADServiceAccount installe le gMSA sur SRV-ORACLE', async () => {
      const { srvOracle } = await labWithGmsa();
      const out = await run(ps(srvOracle), 'Install-ADServiceAccount -Identity "gMSA-Oracle"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Test-ADServiceAccount retourne True sur SRV-ORACLE une fois le gMSA installé', async () => {
      const { srvOracle } = await labWithGmsa();
      const sh = ps(srvOracle);
      await run(sh, 'Install-ADServiceAccount -Identity "gMSA-Oracle"');

      const out = await run(sh, 'Test-ADServiceAccount -Identity "gMSA-Oracle"');
      expect(out.trim()).toBe('True');
    });
  });

  describe('création d\'un sMSA pour un service web', () => {
    async function labWithKds(): Promise<{ dc: WindowsServer; srvWeb: WindowsServer }> {
      const { dc, srvWeb } = await buildLan();
      await run(ps(dc), 'Add-KdsRootKey -EffectiveImmediately');
      return { dc, srvWeb };
    }

    it('New-ADServiceAccount -RestrictToSingleComputer crée sMSA-WebApp lié à SRV-WEB', async () => {
      const { dc } = await labWithKds();
      const sh = ps(dc);
      const out = await run(sh, [
        'New-ADServiceAccount',
        '-Name "sMSA-WebApp"',
        '-DNSHostName "SRV-WEB.mandeng.lan"',
        '-Description "Compte de service gere pour WebApp sur SRV-WEB"',
        '-RestrictToSingleComputer',
        '-Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADServiceAccount "sMSA-WebApp"');
      expect(check).toContain('sMSA-WebApp');
    });

    it('Add-ADComputerServiceAccount lie sMSA-WebApp à la machine SRV-WEB', async () => {
      const { dc } = await labWithKds();
      const sh = ps(dc);
      await run(sh, 'New-ADServiceAccount -Name "sMSA-WebApp" -DNSHostName "SRV-WEB.mandeng.lan" -RestrictToSingleComputer -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');

      const out = await run(sh, 'Add-ADComputerServiceAccount -Identity "SRV-WEB" -ServiceAccount "sMSA-WebApp"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Install-ADServiceAccount puis Test-ADServiceAccount sur SRV-WEB retourne True pour sMSA-WebApp', async () => {
      const { dc, srvWeb } = await labWithKds();
      await run(ps(dc), 'New-ADServiceAccount -Name "sMSA-WebApp" -DNSHostName "SRV-WEB.mandeng.lan" -RestrictToSingleComputer -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');
      await run(ps(dc), 'Add-ADComputerServiceAccount -Identity "SRV-WEB" -ServiceAccount "sMSA-WebApp"');

      const sh = ps(srvWeb);
      await run(sh, 'Install-ADServiceAccount -Identity "sMSA-WebApp"');
      const out = await run(sh, 'Test-ADServiceAccount -Identity "sMSA-WebApp"');
      expect(out.trim()).toBe('True');
    });
  });

  describe('vérification du changement automatique de mot de passe', () => {
    it('Get-ADServiceAccount -Properties PasswordLastSet, ManagedPasswordInterval montre un PasswordLastSet récent et un intervalle de 30 jours', async () => {
      const { dc } = await buildLan();
      await run(ps(dc), 'Add-KdsRootKey -EffectiveImmediately');
      const sh = ps(dc);
      await run(sh, 'New-ADServiceAccount -Name "gMSA-Oracle" -DNSHostName "gmsa-oracle.mandeng.lan" -PrincipalsAllowedToRetrieveManagedPassword "SRV-ORACLE$" -ManagedPasswordIntervalInDays 30 -Path "OU=ServiceAccounts,OU=Mandeng,DC=mandeng,DC=lan"');

      const out = await run(sh, 'Get-ADServiceAccount "gMSA-Oracle" -Properties PasswordLastSet, ManagedPasswordInterval | Select-Object Name, PasswordLastSet, ManagedPasswordInterval');
      expect(out).toMatch(/PasswordLastSet/);
      expect(out).toMatch(/ManagedPasswordInterval\s*:?\s*30|30\s*$/m);
    });
  });
});
