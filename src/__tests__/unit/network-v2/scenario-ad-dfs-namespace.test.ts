/**
 * Scénario 13 — DFS : Distributed File System et espace de noms unifié.
 *
 * Transcription littérale et fidèle : installation des rôles
 * FS-DFS-Namespace/FS-DFS-Replication sur DC01/SRV-FICHIERS, création
 * de l'espace de noms basé domaine \\mandeng.lan\Partages
 * (New-DfsnRoot -Type DomainV2), dossiers DFS avec cibles multiples
 * (New-DfsnFolder/New-DfsnFolderTarget, ReferralPriorityClass
 * GlobalHigh/SiteCostHigh pour la site-awareness), et réplication
 * DFS-R entre SRV-FICHIERS et DC02 (New-DfsReplicationGroup,
 * Add-DfsrMember, New-DfsReplicatedFolder, Add-DfsrConnection,
 * Set-DfsrMembership).
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

async function buildLan(): Promise<{ dc: WindowsServer; dc2: WindowsServer; srvFichiers: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const srvFichiers = new WindowsServer('SRV-FICHIERS');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-srv').connect(srvFichiers.getPorts()[0], sw.getPorts()[2]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[3]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), mask);
  srvFichiers.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  srvFichiers.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Force');

  return { dc, dc2, srvFichiers, client };
}

describe('Scénario 13 — DFS : espace de noms unifié et réplication (mandeng.lan)', () => {
  describe('installation et configuration du DFS', () => {
    it('Invoke-Command installe FS-DFS-Namespace et FS-DFS-Replication sur DC01 et SRV-FICHIERS', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), [
        '$Servers = @("DC01", "SRV-FICHIERS")',
        'foreach ($server in $Servers) {',
        '  Invoke-Command -ComputerName $server -ScriptBlock {',
        '    Install-WindowsFeature -Name FS-DFS-Namespace, FS-DFS-Replication -IncludeManagementTools',
        '  }',
        '}',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('les répertoires physiques D:\\DFS-Root\\IT, Finance, RH sont créés et partagés sur SRV-FICHIERS', async () => {
      const { srvFichiers } = await buildLan();
      const sh = ps(srvFichiers);
      await run(sh, 'New-Item "D:\\DFS-Root" -ItemType Directory -Force');
      await run(sh, 'New-Item "D:\\DFS-Root\\IT" -ItemType Directory -Force');
      await run(sh, 'New-Item "D:\\DFS-Root\\Finance" -ItemType Directory -Force');
      await run(sh, 'New-Item "D:\\DFS-Root\\RH" -ItemType Directory -Force');
      const out = await run(sh, 'New-SmbShare -Name "DFS-Root" -Path "D:\\DFS-Root" -FullAccess "MANDENG\\Domain Admins" -ReadAccess "MANDENG\\Domain Users"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-SmbShare -Name "DFS-Root"');
      expect(check).toContain('DFS-Root');
    });

    it('New-DfsnRoot crée l\'espace de noms basé domaine \\\\mandeng.lan\\Partages avec cible SRV-FICHIERS\\DFS-Root', async () => {
      const { dc, srvFichiers } = await buildLan();
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-SmbShare -Name "DFS-Root" -Path "D:\\DFS-Root"');

      const out = await run(ps(dc), 'New-DfsnRoot -Path "\\\\mandeng.lan\\Partages" -Type DomainV2 -TargetPath "\\\\SRV-FICHIERS\\DFS-Root" -Description "Espace de noms DFS Mandeng"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(ps(dc), 'Get-DfsnRoot -Path "\\\\mandeng.lan\\Partages"');
      expect(check).toContain('\\\\mandeng.lan\\Partages');
    });
  });

  describe('ajout des dossiers DFS avec cibles multiples', () => {
    async function labWithNamespace(): Promise<{ dc: WindowsServer; dc2: WindowsServer; sh: ReturnType<typeof ps> }> {
      const { dc, dc2, srvFichiers } = await buildLan();
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root\\IT" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root\\Finance" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-SmbShare -Name "DFS-Root" -Path "D:\\DFS-Root"');
      const sh = ps(dc);
      await run(sh, 'New-DfsnRoot -Path "\\\\mandeng.lan\\Partages" -Type DomainV2 -TargetPath "\\\\SRV-FICHIERS\\DFS-Root" -Description "Espace de noms DFS Mandeng"');
      return { dc, dc2, sh };
    }

    it('New-DfsnFolder crée \\\\mandeng.lan\\Partages\\IT et \\Finance', async () => {
      const { sh } = await labWithNamespace();
      await run(sh, 'New-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\IT" -Description "Partage equipe IT"');
      const out = await run(sh, 'New-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\Finance" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\Finance" -Description "Partage equipe Finance"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\*" | Select-Object Path, Description | Format-Table');
      expect(check).toContain('\\\\mandeng.lan\\Partages\\IT');
      expect(check).toContain('\\\\mandeng.lan\\Partages\\Finance');
    });

    it('New-DfsnFolderTarget ajoute \\\\DC02\\DFS-Root-Kribi\\IT comme seconde cible du dossier IT', async () => {
      const { sh } = await labWithNamespace();
      await run(sh, 'New-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\IT"');
      const out = await run(sh, 'New-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\DC02\\DFS-Root-Kribi\\IT"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" | Select-Object Path, TargetPath, State, ReferralPriorityClass | Format-Table');
      expect(check).toContain('\\\\SRV-FICHIERS\\DFS-Root\\IT');
      expect(check).toContain('\\\\DC02\\DFS-Root-Kribi\\IT');
    });

    it('Set-DfsnFolderTarget configure GlobalHigh sur SRV-FICHIERS et SiteCostHigh sur DC02 (site-awareness)', async () => {
      const { sh } = await labWithNamespace();
      await run(sh, 'New-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\IT"');
      await run(sh, 'New-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\DC02\\DFS-Root-Kribi\\IT"');

      await run(sh, 'Set-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\IT" -ReferralPriorityClass GlobalHigh');
      await run(sh, 'Set-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\DC02\\DFS-Root-Kribi\\IT" -ReferralPriorityClass SiteCostHigh');

      const out = await run(sh, 'Get-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" | Select-Object TargetPath, ReferralPriorityClass | Format-Table');
      expect(out).toMatch(/SRV-FICHIERS\\DFS-Root\\IT\s+GlobalHigh/);
      expect(out).toMatch(/DC02\\DFS-Root-Kribi\\IT\s+SiteCostHigh/);
    });
  });

  describe('configuration de la réplication DFS-R', () => {
    async function labWithFolderTargets(): Promise<{ srvFichiers: WindowsServer; dc2: WindowsServer; client: WindowsPC; sh: ReturnType<typeof ps> }> {
      const { dc, dc2, srvFichiers, client } = await buildLan();
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-Item "D:\\DFS-Root\\IT" -ItemType Directory -Force');
      await run(ps(srvFichiers), 'New-SmbShare -Name "DFS-Root" -Path "D:\\DFS-Root"');
      const sh = ps(dc);
      await run(sh, 'New-DfsnRoot -Path "\\\\mandeng.lan\\Partages" -Type DomainV2 -TargetPath "\\\\SRV-FICHIERS\\DFS-Root"');
      await run(sh, 'New-DfsnFolder -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\SRV-FICHIERS\\DFS-Root\\IT"');
      await run(sh, 'New-DfsnFolderTarget -Path "\\\\mandeng.lan\\Partages\\IT" -TargetPath "\\\\DC02\\DFS-Root-Kribi\\IT"');
      return { srvFichiers, dc2, client, sh };
    }

    it('New-DfsReplicationGroup crée RG-Partages-IT', async () => {
      const { sh } = await labWithFolderTargets();
      const out = await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT" -Description "Replication DFS pour le partage IT"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      expect(check).toContain('RG-Partages-IT');
    });

    it('Add-DfsrMember ajoute SRV-FICHIERS et DC02 au groupe de réplication', async () => {
      const { sh } = await labWithFolderTargets();
      await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      const out = await run(sh, 'Add-DfsrMember -GroupName "RG-Partages-IT" -ComputerName "SRV-FICHIERS","DC02"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-DfsrMember -GroupName "RG-Partages-IT"');
      expect(check).toContain('SRV-FICHIERS');
      expect(check).toContain('DC02');
    });

    it('New-DfsReplicatedFolder crée le dossier répliqué IT dans RG-Partages-IT', async () => {
      const { sh } = await labWithFolderTargets();
      await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      await run(sh, 'Add-DfsrMember -GroupName "RG-Partages-IT" -ComputerName "SRV-FICHIERS","DC02"');
      const out = await run(sh, 'New-DfsReplicatedFolder -GroupName "RG-Partages-IT" -FolderName "IT"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Add-DfsrConnection configure la connexion de réplication SRV-FICHIERS → DC02', async () => {
      const { sh } = await labWithFolderTargets();
      await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      await run(sh, 'Add-DfsrMember -GroupName "RG-Partages-IT" -ComputerName "SRV-FICHIERS","DC02"');
      const out = await run(sh, 'Add-DfsrConnection -GroupName "RG-Partages-IT" -SourceComputerName "SRV-FICHIERS" -DestinationComputerName "DC02"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-DfsrMembership configure ContentPath et PrimaryMember sur chaque membre du groupe', async () => {
      const { sh } = await labWithFolderTargets();
      await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      await run(sh, 'Add-DfsrMember -GroupName "RG-Partages-IT" -ComputerName "SRV-FICHIERS","DC02"');
      await run(sh, 'New-DfsReplicatedFolder -GroupName "RG-Partages-IT" -FolderName "IT"');

      await run(sh, 'Set-DfsrMembership -GroupName "RG-Partages-IT" -FolderName "IT" -ComputerName "SRV-FICHIERS" -ContentPath "D:\\DFS-Root\\IT" -PrimaryMember $true');
      const out = await run(sh, 'Set-DfsrMembership -GroupName "RG-Partages-IT" -FolderName "IT" -ComputerName "DC02" -ContentPath "D:\\DFS-Root-Kribi\\IT" -PrimaryMember $false');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-DfsrMembership -GroupName "RG-Partages-IT" -FolderName "IT" | Select-Object ComputerName, ContentPath, PrimaryMember | Format-Table');
      expect(check).toMatch(/SRV-FICHIERS\s+D:\\DFS-Root\\IT\s+True/);
      expect(check).toMatch(/DC02\s+D:\\DFS-Root-Kribi\\IT\s+False/);
    });

    it('Get-DfsrState montre SRV-FICHIERS et DC02 avec leur dernière synchronisation', async () => {
      const { sh } = await labWithFolderTargets();
      await run(sh, 'New-DfsReplicationGroup -GroupName "RG-Partages-IT"');
      await run(sh, 'Add-DfsrMember -GroupName "RG-Partages-IT" -ComputerName "SRV-FICHIERS","DC02"');
      await run(sh, 'New-DfsReplicatedFolder -GroupName "RG-Partages-IT" -FolderName "IT"');
      await run(sh, 'Set-DfsrMembership -GroupName "RG-Partages-IT" -FolderName "IT" -ComputerName "SRV-FICHIERS" -ContentPath "D:\\DFS-Root\\IT" -PrimaryMember $true');
      await run(sh, 'Set-DfsrMembership -GroupName "RG-Partages-IT" -FolderName "IT" -ComputerName "DC02" -ContentPath "D:\\DFS-Root-Kribi\\IT" -PrimaryMember $false');

      const out = await run(sh, 'Get-DfsrState -ComputerName "SRV-FICHIERS","DC02" | Select-Object ComputerName, State, LastSyncTime | Format-Table');
      expect(out).toContain('SRV-FICHIERS');
      expect(out).toContain('DC02');
    });

    it('net use \\\\mandeng.lan\\Partages depuis PC-WIN-01 se résout via l\'espace de noms DFS', async () => {
      const { client } = await labWithFolderTargets();
      const out = await client.executeCmdCommand('net use \\\\mandeng.lan\\Partages');
      expect(out).not.toMatch(/not recognized/i);
      expect(out).not.toMatch(/network path was not found/i);
    });
  });
});
