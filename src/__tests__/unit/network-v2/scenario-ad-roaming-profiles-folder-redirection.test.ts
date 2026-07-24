/**
 * Scénario 12 — Profils itinérants et dossiers redirigés.
 *
 * Transcription littérale et fidèle : partage caché `Profils$`/
 * `DossiersRediriges$` sur SRV-FICHIERS avec permissions NTFS isolant
 * chaque utilisateur (Domain Users limité à AppendData/CreateDirectories,
 * CREATOR OWNER hérité en InheritOnly), configuration de `ProfilePath`/
 * `HomeDirectory`/`HomeDrive` par utilisateur (Set-ADUser), et
 * redirection des dossiers Bureau/Documents via GPO
 * (Set-GPRegistryValue sur Shell Folders), vérifiée côté client par
 * gpupdate /force + [System.Environment]::GetFolderPath.
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

async function buildLan(): Promise<{ dc: WindowsServer; srvFichiers: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const srvFichiers = new WindowsServer('SRV-FICHIERS');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-srv').connect(srvFichiers.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  srvFichiers.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
  await run(ps(dc), 'New-ADUser -Name "Pierre Reseau" -SamAccountName preseau -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');

  srvFichiers.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Force');

  return { dc, srvFichiers, client };
}

describe('Scénario 12 — profils itinérants et dossiers redirigés (mandeng.lan)', () => {
  describe('création du partage de profils sur le serveur de fichiers', () => {
    it('New-Item crée C:\\Profils et C:\\DossiersRediriges sur SRV-FICHIERS', async () => {
      const { srvFichiers } = await buildLan();
      const sh = ps(srvFichiers);
      await run(sh, 'New-Item -Path "C:\\Profils" -ItemType Directory -Force');
      const out = await run(sh, 'New-Item -Path "C:\\DossiersRediriges" -ItemType Directory -Force');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('New-SmbShare "Profils$" est un partage caché avec FullAccess Domain Admins et ChangeAccess Domain Users', async () => {
      const { srvFichiers } = await buildLan();
      const sh = ps(srvFichiers);
      await run(sh, 'New-Item -Path "C:\\Profils" -ItemType Directory -Force');
      const out = await run(sh, [
        'New-SmbShare',
        '-Name "Profils$"',
        '-Path "C:\\Profils"',
        '-Description "Profils itinerants Mandeng"',
        '-FullAccess "MANDENG\\Domain Admins"',
        '-ChangeAccess "MANDENG\\Domain Users"',
        '-ReadAccess "CREATOR OWNER"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-SmbShare -Name "Profils$"');
      expect(check).toContain('Profils$');
    });

    it('New-SmbShare "DossiersRediriges$" est créé avec accès Domain Admins et Domain Users', async () => {
      const { srvFichiers } = await buildLan();
      const sh = ps(srvFichiers);
      await run(sh, 'New-Item -Path "C:\\DossiersRediriges" -ItemType Directory -Force');
      const out = await run(sh, 'New-SmbShare -Name "DossiersRediriges$" -Path "C:\\DossiersRediriges" -Description "Dossiers rediriges Mandeng" -FullAccess "MANDENG\\Domain Admins","MANDENG\\Domain Users"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-SmbShare -Name "DossiersRediriges$"');
      expect(check).toContain('DossiersRediriges$');
    });

    it('les permissions NTFS isolent chaque utilisateur (Domain Users limité à AppendData/CreateDirectories, CREATOR OWNER en InheritOnly)', async () => {
      const { srvFichiers } = await buildLan();
      const sh = ps(srvFichiers);
      await run(sh, 'New-Item -Path "C:\\Profils" -ItemType Directory -Force');
      const out = await run(sh, [
        '$ACL = Get-Acl "C:\\Profils"',
        '$ACL.SetAccessRuleProtection($true, $false)',
        '$Rules = @(',
        '  New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"),',
        '  New-Object System.Security.AccessControl.FileSystemAccessRule("MANDENG\\Domain Admins", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"),',
        '  New-Object System.Security.AccessControl.FileSystemAccessRule("MANDENG\\Domain Users", "AppendData,CreateDirectories", "None", "None", "Allow"),',
        '  New-Object System.Security.AccessControl.FileSystemAccessRule("CREATOR OWNER", "FullControl", "ContainerInherit,ObjectInherit", "InheritOnly", "Allow")',
        ')',
        'foreach ($rule in $Rules) { $ACL.AddAccessRule($rule) }',
        'Set-Acl "C:\\Profils" $ACL',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, '(Get-Acl "C:\\Profils").Access | Select-Object IdentityReference, FileSystemRights | Format-Table -AutoSize');
      expect(check).toMatch(/Domain Users\s+AppendData/);
      expect(check).toMatch(/CREATOR OWNER\s+FullControl/);
    });
  });

  describe('configuration du chemin de profil par utilisateur', () => {
    it('Set-ADUser -ProfilePath configure le chemin de profil itinérant de jadmin', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      const out = await run(sh, 'Set-ADUser "jadmin" -ProfilePath "\\\\SRV-FICHIERS\\Profils$\\jadmin"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADUser "jadmin" -Properties ProfilePath | Select-Object Name, ProfilePath');
      expect(check).toContain('\\\\SRV-FICHIERS\\Profils$\\jadmin');
    });

    it('Set-ADUser -ProfilePath configure aussi le profil itinérant de preseau', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'Set-ADUser "preseau" -ProfilePath "\\\\SRV-FICHIERS\\Profils$\\preseau"');

      const check = await run(sh, 'Get-ADUser "preseau" -Properties ProfilePath | Select-Object Name, ProfilePath');
      expect(check).toContain('\\\\SRV-FICHIERS\\Profils$\\preseau');
    });

    it('Set-ADUser -HomeDirectory -HomeDrive H: configure le dossier personnel de jadmin', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      const out = await run(sh, 'Set-ADUser "jadmin" -HomeDirectory "\\\\SRV-FICHIERS\\DossiersRediriges$\\jadmin" -HomeDrive "H:"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADUser "jadmin" -Properties ProfilePath, HomeDirectory, HomeDrive | Select-Object Name, ProfilePath, HomeDirectory, HomeDrive');
      expect(check).toContain('\\\\SRV-FICHIERS\\DossiersRediriges$\\jadmin');
      expect(check).toMatch(/HomeDrive\s*:\s*H:|H:\s/);
    });
  });

  describe('configuration de la redirection de dossiers via GPO', () => {
    async function labWithGpo(): Promise<{ dc: WindowsServer; client: WindowsPC; sh: ReturnType<typeof ps> }> {
      const { dc, client } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-GPO -Name "MANDENG-Folder-Redirection" -Domain "mandeng.lan"');
      return { dc, client, sh };
    }

    it('New-GPO crée MANDENG-Folder-Redirection', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'Get-GPO -Name "MANDENG-Folder-Redirection"');
      expect(out).toContain('MANDENG-Folder-Redirection');
    });

    it('Set-GPRegistryValue redirige Desktop vers \\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Desktop', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, [
        'Set-GPRegistryValue',
        '-Name "MANDENG-Folder-Redirection"',
        '-Key "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders"',
        '-ValueName "Desktop"',
        '-Type ExpandString',
        '-Value "\\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Desktop"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-GPRegistryValue redirige Documents (Personal) vers \\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Documents', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, [
        'Set-GPRegistryValue',
        '-Name "MANDENG-Folder-Redirection"',
        '-Key "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders"',
        '-ValueName "Personal"',
        '-Type ExpandString',
        '-Value "\\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Documents"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('New-GPLink lie MANDENG-Folder-Redirection à OU=Utilisateurs', async () => {
      const { sh } = await labWithGpo();
      const out = await run(sh, 'New-GPLink -Name "MANDENG-Folder-Redirection" -Target "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -LinkEnabled Yes');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-GPInheritance -Target "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" | Select-Object -ExpandProperty GpoLinks | Select-Object DisplayName');
      expect(check).toContain('MANDENG-Folder-Redirection');
    });

    it('après gpupdate /force côté client, GetFolderPath("Desktop") et GetFolderPath("MyDocuments") pointent vers les chemins redirigés de jadmin', async () => {
      const { dc, client } = await labWithGpo();
      await run(ps(dc), [
        'Set-GPRegistryValue -Name "MANDENG-Folder-Redirection" -Key "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders" -ValueName "Desktop" -Type ExpandString -Value "\\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Desktop"',
        'Set-GPRegistryValue -Name "MANDENG-Folder-Redirection" -Key "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders" -ValueName "Personal" -Type ExpandString -Value "\\\\SRV-FICHIERS\\DossiersRediriges$\\%USERNAME%\\Documents"',
        'New-GPLink -Name "MANDENG-Folder-Redirection" -Target "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -LinkEnabled Yes',
      ].join('\n'));

      const clientSh = ps(client);
      await run(clientSh, 'runas /user:MANDENG\\jadmin whoami');
      await run(clientSh, 'gpupdate /force');

      const desktop = await run(clientSh, '[System.Environment]::GetFolderPath("Desktop")');
      expect(desktop).toContain('\\\\SRV-FICHIERS\\DossiersRediriges$\\jadmin\\Desktop');

      const documents = await run(clientSh, '[System.Environment]::GetFolderPath("MyDocuments")');
      expect(documents).toContain('\\\\SRV-FICHIERS\\DossiersRediriges$\\jadmin\\Documents');
    });
  });
});
