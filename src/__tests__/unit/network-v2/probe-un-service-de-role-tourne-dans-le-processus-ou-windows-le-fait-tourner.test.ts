/**
 * Un service de role tourne dans le processus ou Windows le fait tourner : l'annuaire dans lsass.exe, DHCP, NPS et IIS
 * dans un svchost, les autres dans l'image que nomme leur chemin binaire ; et la machine n'expose plus d'image qui
 * n'existe pas (LanmanServer.exe, LanmanWorkstation.exe).
 *
 * Mesure de depart (2d36ab993), un WindowsServer : `Install-WindowsFeature AD-Domain-Services` creait trois processus,
 * `ntds.exe`, `netlogon.exe` et `kdc.exe`, la ou NTDS, Netlogon et Kdc ont `lsass.exe` pour chemin binaire (`sc qc` :
 * WIN32_SHARE_PROCESS) ; DHCP, NPAS et Web-Server creaient `dhcpserver.exe`, `ias.exe` et `w3svc.exe`, des processus
 * nommes d'apres le service, la ou ces trois services tournent dans un svchost (W3SVC : `svchost.exe -k iissvcs`) ;
 * `sc create MySvc binPath= "C:\tools\agent.exe"` puis `sc start MySvc` lancait `mysvc.exe`, jamais `agent.exe` ;
 * `tasklist` listait `LanmanServer.exe` (PID 2200) et `LanmanWorkstation.exe` (PID 2400), deux images qui n'existent
 * pas -- les deux services tournent dans des svchost -- ; aucun service IP Helper (`iphlpsvc`) ; les trois services
 * Exchange d'un role Mailbox tournaient dans `msexchangetransport.exe`, `msexchangeis.exe` et `msexchangeadtopology.exe`.
 * Le type du service (`sc qc` : WIN32_OWN_PROCESS ou WIN32_SHARE_PROCESS) etait lui aussi decorrele du processus, et le
 * 4688 d'un processus de service portait son nom (`svchost.exe`) la ou `sc qc` dit `svchost.exe -k dhcpserver`.
 *
 * Autorites : Microsoft Learn, `sc qc` (le chemin binaire du service et son type disent s'il partage un processus) ; le
 * chemin de W3SVC, `C:\WINDOWS\System32\svchost.exe -k iissvcs` (billet Microsoft « Fail to start W3SVC ») ; le service
 * IP Helper (`iphlpsvc`), `svchost.exe -k NetSvcs`, porte le port proxy (SANS ISC, diary 27934) ; `EdgeTransport.exe`,
 * « the executable file used by the Microsoft Exchange Transport service » (documentation Exchange). Non confirme
 * depuis cet environnement : les noms d'image `Microsoft.Exchange.Store.Service.exe` et `MSExchangeFrontendTransport.exe`
 * (seul `Microsoft.Exchange.Directory.TopologyService` apparait, comme nom de processus, dans un article Microsoft),
 * `DFSR.exe`, et les groupes `-k` de DHCPServer et d'IAS.
 *
 * Ce qui est construit : le processus d'un service est l'image que nomme son chemin binaire (`serviceImageOf`) et le
 * type du service en decoule (`lsass.exe` et `svchost.exe` sont les hotes partages) ; la table des fonctionnalites
 * porte l'image des services de role (`images`) et `RoleManager` la donne a la creation ; un service hote dans
 * `lsass.exe` ou dans un svchost qui reste ne tue pas son hote en s'arretant, et un svchost cree pour un role sort avec
 * lui ; `LanmanServer` et `iphlpsvc` rejoignent le svchost des services reseau, `LanmanWorkstation` celui du
 * NetworkService ; chaque service Exchange a son image ; la ligne de commande d'un processus de service est le chemin
 * binaire du gestionnaire de services, que le 4688 enregistre.
 *
 * Ce qui n'est PAS construit : les groupes `-k` d'un svchost (un svchost cree pour un role n'heberge que ce role, et son
 * `-k` est celui du chemin binaire du service) ; l'image `Microsoft.Exchange.Store.Service.exe` ne lance pas ses
 * processus de travail par base.
 *
 * Discrimination (fichier copie sur 2d36ab993) : DOUZE cas sur dix-sept tombent. Les cinq autres passent des deux cotes : le
 * temoin (sshd.exe et spoolsv.exe), deux coincidences (le nom du service donne la bonne image : `dns.exe` et
 * `clussvc.exe`) et deux non-regressions (lsass.exe est critique ; arreter tous les services de l'annuaire laisse
 * lsass.exe vivant). Mutations, toutes tuees : image du chemin binaire ignoree 10 ; catalogue sans images 8 ;
 * lsass.exe sans hebergement 3 ; svchost cree pour un role qui reste vide 3 ; hote partage tue avec son dernier
 * service 1 ; tout service en processus propre 1 ; pas de svchost neuf 4 ; chemin complet pris pour l'image 12 ;
 * LanmanWorkstation hors svchost 1 ; LanmanServer et iphlpsvc hors svchost 1 ; sans service iphlpsvc 1 ; une seule
 * image pour Exchange 1 ; ligne de commande d'un processus propre ou d'un svchost reduite au nom 1 et 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  resetExchangeOrganizations();
});

function server(): WindowsServer {
  const srv = new WindowsServer('SRV', 0, 0);
  srv.powerOn();
  srv.setCurrentUser('Administrator');
  return srv;
}

const powershell = (windows: WindowsServer, command: string) => windows.executeCommand(`powershell -Command "${command}"`);
const tasklist = (windows: WindowsServer) => windows.executeCommand('tasklist /svc');
const pidOf = async (windows: WindowsServer, service: string): Promise<number> =>
  Number(/PID\s*:\s*(\d+)/.exec(await windows.executeCommand(`sc queryex ${service}`))![1]);
const imageRows = async (windows: WindowsServer, image: string): Promise<string[]> =>
  (await tasklist(windows)).split('\n').filter((line) => line.startsWith(image));

describe('the bench is sound (witness)', () => {
  it('sshd runs in sshd.exe and Spooler in spoolsv.exe, as queryex and tasklist both say', async () => {
    const windows = server();
    expect(await pidOf(windows, 'sshd')).toBe(1088);
    expect(await imageRows(windows, 'spoolsv.exe')).toHaveLength(1);
    expect(await pidOf(windows, 'Spooler')).toBe(1800);
  });
});

describe('a role service runs in the process Windows runs it in', () => {
  it('Active Directory Domain Services: NTDS, Netlogon and Kdc live in lsass.exe, no process of their own', async () => {
    const windows = server();
    await powershell(windows, 'Install-WindowsFeature AD-Domain-Services');
    const lsass = (await imageRows(windows, 'lsass.exe')).map((row) => Number(row.split(/\s+/)[1]));
    expect(lsass).toHaveLength(1);
    for (const service of ['NTDS', 'Netlogon', 'Kdc']) expect(await pidOf(windows, service)).toBe(lsass[0]);
    expect((await imageRows(windows, 'lsass.exe'))[0]).toMatch(/Kdc/);
    for (const image of ['ntds.exe', 'netlogon.exe', 'kdc.exe']) expect(await imageRows(windows, image)).toEqual([]);
  });

  it.each([
    ['DNS', 'DNS', 'dns.exe'],
    ['FS-DFS-Replication', 'DFSR', 'DFSR.exe'],
    ['UpdateServices', 'WsusService', 'WsusService.exe'],
    ['Failover-Clustering', 'ClusSvc', 'clussvc.exe'],
  ])('%s: %s runs in %s and the process leaves with the role', async (feature, service, image) => {
    const windows = server();
    await powershell(windows, `Install-WindowsFeature ${feature}`);
    const rows = await imageRows(windows, image);
    expect(rows).toHaveLength(1);
    expect(await pidOf(windows, service)).toBe(Number(rows[0].split(/\s+/)[1]));
    await powershell(windows, `Uninstall-WindowsFeature ${feature}`);
    expect(await imageRows(windows, image)).toEqual([]);
  });

  it.each([
    ['DHCP', 'DHCPServer'],
    ['NPAS', 'IAS'],
    ['Web-Server', 'W3SVC'],
  ])('%s: %s runs in an svchost of its own, which exits with the role', async (feature, service) => {
    const windows = server();
    const before = (await imageRows(windows, 'svchost.exe')).length;
    await powershell(windows, `Install-WindowsFeature ${feature}`);
    const pid = await pidOf(windows, service);
    expect(pid).not.toBe(0);
    expect(await windows.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`)).toMatch(new RegExp(`svchost\\.exe\\s+${pid}\\s+${service}`));
    expect(await imageRows(windows, 'svchost.exe')).toHaveLength(before + 1);
    await powershell(windows, `Uninstall-WindowsFeature ${feature}`);
    expect(await imageRows(windows, 'svchost.exe')).toHaveLength(before);
  });

  it('sc qc says what the process model says: own process for dns.exe, shared for lsass.exe and svchost', async () => {
    const windows = server();
    await powershell(windows, 'Install-WindowsFeature DNS');
    await powershell(windows, 'Install-WindowsFeature DHCP');
    await powershell(windows, 'Install-WindowsFeature AD-Domain-Services');
    expect(await windows.executeCommand('sc qc DNS')).toMatch(/TYPE\s*:\s*10\s+WIN32_OWN_PROCESS/);
    expect(await windows.executeCommand('sc qc DHCPServer')).toMatch(/TYPE\s*:\s*20\s+WIN32_SHARE_PROCESS/);
    expect(await windows.executeCommand('sc qc NTDS')).toMatch(/TYPE\s*:\s*20\s+WIN32_SHARE_PROCESS/);
  });
});

describe('a service in a shared process comes and goes without touching its host', () => {
  it('stopping and starting Kdc leaves lsass.exe running and hosting it again', async () => {
    const windows = server();
    await powershell(windows, 'Install-WindowsFeature AD-Domain-Services');
    const lsass = Number((await imageRows(windows, 'lsass.exe'))[0].split(/\s+/)[1]);
    await windows.executeCommand('sc stop Kdc');
    expect((await imageRows(windows, 'lsass.exe'))[0]).not.toMatch(/Kdc/);
    expect(await pidOf(windows, 'Kdc')).toBe(0);
    await windows.executeCommand('sc start Kdc');
    expect(Number((await imageRows(windows, 'lsass.exe'))[0].split(/\s+/)[1])).toBe(lsass);
    expect(await pidOf(windows, 'Kdc')).toBe(lsass);
  });

  it('stopping every service of AD DS leaves lsass.exe alive, hosting nothing', async () => {
    const windows = server();
    await powershell(windows, 'Install-WindowsFeature AD-Domain-Services');
    for (const service of ['Kdc', 'Netlogon', 'NTDS']) await windows.executeCommand(`sc stop ${service}`);
    const rows = await imageRows(windows, 'lsass.exe');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/NTDS|Kdc|Netlogon/);
  });

  it('lsass.exe is critical: killing it is refused', async () => {
    const windows = server();
    await powershell(windows, 'Install-WindowsFeature AD-Domain-Services');
    expect(await windows.executeCommand('taskkill /F /PID 636')).toMatch(/critical|denied/i);
    expect(await imageRows(windows, 'lsass.exe')).toHaveLength(1);
  });
});

describe('a service created by the operator runs the image its path names', () => {
  it('sc create ... binPath= "C:\\tools\\agent.exe" then sc start: agent.exe, not <name>.exe', async () => {
    const windows = server();
    await windows.executeCommand('sc create MySvc binPath= "C:\\tools\\agent.exe --serve"');
    await windows.executeCommand('sc start MySvc');
    expect(await imageRows(windows, 'agent.exe')).toHaveLength(1);
    expect(await imageRows(windows, 'mysvc.exe')).toEqual([]);
    expect(await pidOf(windows, 'MySvc')).toBe(Number((await imageRows(windows, 'agent.exe'))[0].split(/\s+/)[1]));
  });
});

describe('the services a machine ships run in processes that exist on a real Windows', () => {
  it('LanmanServer, LanmanWorkstation and iphlpsvc are hosted by svchost.exe, and no LanmanServer.exe or LanmanWorkstation.exe exists', async () => {
    const windows = server();
    for (const service of ['LanmanServer', 'LanmanWorkstation', 'iphlpsvc']) {
      const pid = await pidOf(windows, service);
      expect(pid).not.toBe(0);
      expect(await windows.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`)).toMatch(new RegExp(`svchost\\.exe\\s+${pid}\\s+.*${service}`));
    }
    const tasks = await tasklist(windows);
    expect(tasks).not.toContain('LanmanServer.exe');
    expect(tasks).not.toContain('LanmanWorkstation.exe');
  });

  it('the Exchange services each run in their own image, not in one shared edgetransport.exe', async () => {
    const windows = server();
    const run = async (line: string) => (await PowerShellSubShell.create(windows).subShell.processLine(line)).output.join('\n');
    await run('Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run('Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    const images: string[] = [];
    for (const service of ['MSExchangeTransport', 'MSExchangeIS', 'MSExchangeADTopology']) {
      const pid = await pidOf(windows, service);
      images.push((await tasklist(windows)).split('\n').find((line) => new RegExp(`\\s${pid}\\s`).test(line))!.trim().split(/\s+/)[0]);
    }
    expect(images.sort()).toEqual([
      'EdgeTransport.exe', 'Microsoft.Exchange.Directory.TopologyService.exe', 'Microsoft.Exchange.Store.Service.exe',
    ]);
  });
});

describe('the command line of a service process is the binary path the service control manager holds', () => {
  it('role services started once process-creation auditing is on are recorded by 4688 with their binPath', async () => {
    const windows = server();
    const run = async (line: string) => (await PowerShellSubShell.create(windows).subShell.processLine(line)).output.join('\n');
    await windows.executeCmdCommand('auditpol /set /subcategory:"Process Creation" /success:enable');
    await run('New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Force');
    await run('Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Name "ProcessCreationIncludeCmdLine_Enabled" -Value 1 -Type DWord');
    await powershell(windows, 'Install-WindowsFeature DHCP');
    await powershell(windows, 'Install-WindowsFeature DNS');
    const commandLines = await run([
      "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688 } | ForEach-Object {",
      '  $xml = [xml]$_.ToXml()',
      "  $xml.Event.EventData.Data | Where-Object {$_.Name -eq 'CommandLine'} | Select-Object -ExpandProperty '#text'",
      '}',
    ].join('\n'));
    expect(commandLines).toContain('C:\\Windows\\System32\\svchost.exe -k dhcpserver');
    expect(commandLines).toContain('C:\\Windows\\System32\\dns.exe');
  });
});
