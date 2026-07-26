/**
 * Scénario 11 — Sites AD et réplication inter-sites : configuration et
 * optimisation.
 *
 * Transcription littérale et fidèle : renommage du site par défaut
 * (Default-First-Site-Name → Douala-Siege), création du site distant
 * Kribi-Agence, association des sous-réseaux IP aux sites
 * (New-ADReplicationSubnet), création d'un lien de site dédié
 * Douala-Kribi-Link (coût 50, fréquence 60 min) plus permissif que
 * DEFAULTIPSITELINK (coût 100), déplacement de DC02 vers Kribi-Agence
 * (Move-ADDirectoryServer), et vérification de la topologie
 * inter-sites (ISTG, repadmin /kcc, /showrepl).
 *
 * DC01 et DC02 restent câblés sur le même commutateur (même précédent
 * que scenario-ad-replication-topology.test.ts/scenario-ad-fsmo-roles.test.ts)
 * — l'affectation de site est une métadonnée administrative indépendante
 * de la connectivité IP réelle du DC (exactement pourquoi
 * Move-ADDirectoryServer -Site existe : c'est le rattrapage d'un DC dont
 * l'adresse ne correspond à aucun objet sous-réseau du bon site).
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

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc1), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  return { dc1, dc2 };
}

describe('Scénario 11 — sites AD et réplication inter-sites (Douala/Kribi)', () => {
  describe('création des sites et sous-réseaux', () => {
    it('Get-ADReplicationSite -Filter * liste Default-First-Site-Name', async () => {
      const { dc1 } = await buildTwoDcs();
      const out = await run(ps(dc1), 'Get-ADReplicationSite -Filter *');
      expect(out).toContain('Default-First-Site-Name');
      expect(out).toMatch(/CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=mandeng,DC=lan/);
    });

    it('Set-ADReplicationSite renomme Default-First-Site-Name en Douala-Siege', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      const out = await run(sh, 'Get-ADReplicationSite "Default-First-Site-Name" | Set-ADReplicationSite -Name "Douala-Siege"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADReplicationSite -Filter *');
      expect(check).toContain('Douala-Siege');
      expect(check).not.toContain('Default-First-Site-Name');
    });

    it('New-ADReplicationSite crée le site distant Kribi-Agence', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, 'Get-ADReplicationSite "Default-First-Site-Name" | Set-ADReplicationSite -Name "Douala-Siege"');
      await run(sh, 'New-ADReplicationSite -Name "Kribi-Agence" -Description "Site de l\'agence de Kribi"');

      const out = await run(sh, 'Get-ADReplicationSite -Filter *');
      expect(out).toContain('Douala-Siege');
      expect(out).toContain('Kribi-Agence');
    });

    it('New-ADReplicationSubnet associe 192.168.10.0/24 et 192.168.99.0/24 à Douala-Siege et 192.168.20.0/24 à Kribi-Agence', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, 'Get-ADReplicationSite "Default-First-Site-Name" | Set-ADReplicationSite -Name "Douala-Siege"');
      await run(sh, 'New-ADReplicationSite -Name "Kribi-Agence" -Description "Site de l\'agence de Kribi"');

      await run(sh, 'New-ADReplicationSubnet -Name "192.168.10.0/24" -Site "Douala-Siege" -Description "LAN Siege Mandeng Douala"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.20.0/24" -Site "Kribi-Agence" -Description "LAN Agence Mandeng Kribi"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.99.0/24" -Site "Douala-Siege" -Description "VLAN Admin Douala"');

      const out = await run(sh, 'Get-ADReplicationSubnet -Filter * | Select-Object Name, Site, Description | Format-Table -AutoSize');
      expect(out).toContain('192.168.10.0/24');
      expect(out).toContain('192.168.20.0/24');
      expect(out).toContain('192.168.99.0/24');
      expect(out).toMatch(/192\.168\.10\.0\/24\s+Douala-Siege/);
      expect(out).toMatch(/192\.168\.20\.0\/24\s+Kribi-Agence/);
      expect(out).toMatch(/192\.168\.99\.0\/24\s+Douala-Siege/);
    });
  });

  describe('configuration du lien de site inter-sites', () => {
    async function labWithSites(): Promise<ReturnType<typeof ps>> {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, 'Get-ADReplicationSite "Default-First-Site-Name" | Set-ADReplicationSite -Name "Douala-Siege"');
      await run(sh, 'New-ADReplicationSite -Name "Kribi-Agence" -Description "Site de l\'agence de Kribi"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.10.0/24" -Site "Douala-Siege"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.20.0/24" -Site "Kribi-Agence"');
      return sh;
    }

    it('Get-ADReplicationSiteLink -Filter * montre DEFAULTIPSITELINK avec Cost=100 et ReplicationFrequencyInMinutes=180', async () => {
      const sh = await labWithSites();
      const out = await run(sh, 'Get-ADReplicationSiteLink -Filter *');
      expect(out).toContain('DEFAULTIPSITELINK');
      expect(out).toMatch(/Cost\s*:\s*100/);
      expect(out).toMatch(/ReplicationFrequencyInMinutes\s*:\s*180/);
    });

    it('New-ADReplicationSiteLink crée Douala-Kribi-Link (Cost=50, Frequence=60min, IP) entre les deux sites', async () => {
      const sh = await labWithSites();
      const out = await run(sh, [
        'New-ADReplicationSiteLink',
        '-Name "Douala-Kribi-Link"',
        '-SitesIncluded @("Douala-Siege", "Kribi-Agence")',
        '-Cost 50',
        '-ReplicationFrequencyInMinutes 60',
        '-InterSiteTransportProtocol IP',
        '-Description "Lien WAN Douala-Kribi via VPN IPsec"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADReplicationSiteLink -Identity "Douala-Kribi-Link"');
      expect(check).toMatch(/Cost\s*:\s*50/);
      expect(check).toMatch(/ReplicationFrequencyInMinutes\s*:\s*60/);
      expect(check).toContain('Douala-Siege');
      expect(check).toContain('Kribi-Agence');
    });

    it('le coût de Douala-Kribi-Link (50) est strictement inférieur à celui de DEFAULTIPSITELINK (100)', async () => {
      const sh = await labWithSites();
      await run(sh, 'New-ADReplicationSiteLink -Name "Douala-Kribi-Link" -SitesIncluded @("Douala-Siege", "Kribi-Agence") -Cost 50 -ReplicationFrequencyInMinutes 60 -InterSiteTransportProtocol IP');

      const out = await run(sh, 'Get-ADReplicationSiteLink -Filter * | Select-Object Name, Cost | Format-Table -AutoSize');
      expect(out).toMatch(/DEFAULTIPSITELINK\s+100/);
      expect(out).toMatch(/Douala-Kribi-Link\s+50/);
    });

    it('Set-ADReplicationSiteLink applique un planning horaire (réplication autorisée 7h-22h)', async () => {
      const sh = await labWithSites();
      await run(sh, 'New-ADReplicationSiteLink -Name "Douala-Kribi-Link" -SitesIncluded @("Douala-Siege", "Kribi-Agence") -Cost 50 -ReplicationFrequencyInMinutes 60 -InterSiteTransportProtocol IP');
      const out = await run(sh, [
        '$Schedule = New-Object System.DirectoryServices.ActiveDirectorySchedule',
        'foreach ($day in 0..6) {',
        '  foreach ($hour in 7..21) {',
        '    $Schedule.SetSchedule([System.DayOfWeek]$day, [System.HourOfDay]$hour, [System.HourOfDay]($hour + 1))',
        '  }',
        '}',
        'Set-ADReplicationSiteLink "Douala-Kribi-Link" -ReplicationSchedule $Schedule',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('déplacement du second DC dans le bon site', () => {
    async function labWithSitesAndLink(): Promise<{ dc1: WindowsServer; dc2: WindowsServer; sh: ReturnType<typeof ps> }> {
      const { dc1, dc2 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, 'Get-ADReplicationSite "Default-First-Site-Name" | Set-ADReplicationSite -Name "Douala-Siege"');
      await run(sh, 'New-ADReplicationSite -Name "Kribi-Agence" -Description "Site de l\'agence de Kribi"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.10.0/24" -Site "Douala-Siege"');
      await run(sh, 'New-ADReplicationSubnet -Name "192.168.20.0/24" -Site "Kribi-Agence"');
      await run(sh, 'New-ADReplicationSiteLink -Name "Douala-Kribi-Link" -SitesIncluded @("Douala-Siege", "Kribi-Agence") -Cost 50 -ReplicationFrequencyInMinutes 60 -InterSiteTransportProtocol IP');
      return { dc1, dc2, sh };
    }

    it('Move-ADDirectoryServer déplace DC02.mandeng.lan vers le site Kribi-Agence', async () => {
      const { sh } = await labWithSitesAndLink();
      const out = await run(sh, 'Move-ADDirectoryServer -Identity "DC02.mandeng.lan" -Site "Kribi-Agence"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADDomainController -Filter * | Select-Object HostName, Site, IPv4Address | Format-Table -AutoSize');
      expect(check).toMatch(/DC01\.mandeng\.lan\s+Douala-Siege/);
      expect(check).toMatch(/DC02\.mandeng\.lan\s+Kribi-Agence/);
    });

    // Pas de InterSiteTopologyGenerator/ISTG modélisé ici : c'est une donnée
    // élue par le KCC, explicitement hors périmètre (PRD-Repadmin.md §0.2,
    // hérité de PRD-Windows-Server-Advanced.md §2.2 — `/kcc`, `/bridgeheads`,
    // `/istg`, `/siteoptions`). On vérifie à la place que le site
    // Douala-Siege reste correct après le déplacement explicite de DC02.
    it('Get-ADReplicationSite "Douala-Siege" reste valide après le déplacement de DC02 vers Kribi-Agence', async () => {
      const { sh } = await labWithSitesAndLink();
      await run(sh, 'Move-ADDirectoryServer -Identity "DC02.mandeng.lan" -Site "Kribi-Agence"');

      const out = await run(sh, 'Get-ADReplicationSite "Douala-Siege"');
      expect(out).not.toMatch(/not recognized/i);
      expect(out).toContain('Douala-Siege');
    });

    // Pas de KCC réel modélisé (PRD-Repadmin.md §0.2, hérité de
    // PRD-Windows-Server-Advanced.md §2.2) : `/kcc`, `/bridgeheads`,
    // `/istg`, `/siteoptions` restent hors périmètre — `/kcc` répond par
    // le message honnête déjà établi plutôt que de simuler un succès.
    it('repadmin /kcc répond par le message honnête documenté (pas de KCC réel modélisé)', async () => {
      const { dc1, sh } = await labWithSitesAndLink();
      await run(sh, 'Move-ADDirectoryServer -Identity "DC02.mandeng.lan" -Site "Kribi-Agence"');

      const out = await dc1.executeCmdCommand('repadmin /kcc');
      expect(out).toMatch(/does not model automatic inter-site topology generation/i);
    });

    it('repadmin /showrepl DC01.mandeng.lan indique une réplication inter-site vers Kribi-Agence\\DC02', async () => {
      const { dc1, sh } = await labWithSitesAndLink();
      await run(sh, 'Move-ADDirectoryServer -Identity "DC02.mandeng.lan" -Site "Kribi-Agence"');
      // The move alone doesn't retroactively relabel DC02's initial-sync
      // log entry (recorded intra-site, honestly, since no site existed
      // yet at that point) — a fresh pull after the move is what actually
      // reflects the new inter-site relationship, same as real repadmin
      // only ever describing replication attempts that actually happened.
      dc1.replicateFrom('192.168.10.11');

      const out = await dc1.executeCmdCommand('repadmin /showrepl DC01.mandeng.lan');
      expect(out).toMatch(/Kribi-Agence\\DC02/);
      expect(out).toMatch(/inter-site/i);
      expect(out).toMatch(/was successful/i);
    });

    it('Get-ADReplicationUpToDatenessVectorTable liste DC02 avec sa dernière réplication réussie', async () => {
      const { dc1, sh } = await labWithSitesAndLink();
      await run(sh, 'Move-ADDirectoryServer -Identity "DC02.mandeng.lan" -Site "Kribi-Agence"');
      dc1.replicateFrom('192.168.10.11');

      const out = await run(sh, 'Get-ADReplicationUpToDatenessVectorTable -Target "DC01.mandeng.lan" | Select-Object Server, UsnFilter, LastReplicationSuccess | Format-Table -AutoSize');
      expect(out).not.toMatch(/not recognized/i);
      expect(out).toContain('DC02');
    });
  });
});
