/**
 * Un port Windows n'est ouvert que si la fonctionnalite qui le sert est active, et il appartient au processus qui la
 * sert : RDP, WinRM, un controleur de domaine, DFS Replication, WSUS et le service d'impression ne laissent plus
 * d'ecoute fantome, et chaque ligne `LISTENING` de `netstat -ano` porte le PID d'un processus que `tasklist` connait.
 *
 * Mesure de depart (ce9f180db, le lot des services), un LinuxPC et un WindowsPC, puis un WindowsServer, par defaut
 * (RDP desactive, ni domaine ni role) : `nc -zv 10.0.0.7 <port>` REUSSISSAIT pour 3389, 5985, 389, 3268, 636, 3269, 88,
 * 5722, 8530 et 515, et `netstat -ano` les listait tous en `LISTENING`, neuf avec le PID 0 et 3389 avec le PID 1096 que
 * `tasklist` ne connaissait pas ; 135 portait le PID 0 aussi. Les dix ecoutes etaient ouvertes a la construction de la
 * machine (`initDefaultSockets`) et chacune verifiait sa fonctionnalite a l'ACCEPTATION, pour fermer la prise une fois
 * la poignee de main faite : un `Test-NetConnection` ou un `nmap` y voyait un port ouvert la ou un Windows reel repond
 * par un refus. Le poste client portait meme les ports d'un controleur de domaine, de DFSR, de WSUS et d'un serveur
 * d'impression, des roles qu'il ne peut pas installer. RDP avait deux interrupteurs qui ne se parlaient pas : le champ
 * `rdp.enabled` que `Enable-RemoteDesktop` basculait, et la valeur de registre `fDenyTSConnections`, absente de la
 * ruche, qu'un `reg add` ou un `Set-ItemProperty` ecrivait dans le vide.
 *
 * Autorites : `netstat -ano` et `Test-NetConnection` lisent ce que la pile ecoute, rien d'autre ; Microsoft Learn, « Client
 * is disconnected during Group Policy update » : `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server`, valeur
 * `fDenyTSConnections`, 1 bloque toutes les connexions et 0 les autorise ; le port 5985 d'une ecoute WinRM est tenu par
 * le PID 4 (HTTP.sys, le noyau) -- les fils Microsoft Q&A sur « WinRM Listener not bound to IPv4 » montrent `[::]:5985
 * LISTENING 4` -- comme tout site HTTP servi par HTTP.sys, donc WSUS sur 8530 ; LDAP et le KDC tournent dans
 * `lsass.exe` ; le mappeur de points d'extremite RPC (135) est dans le svchost de `RpcSs` ; RDP est servi par
 * `TermService`, dans un svchost. Non confirme depuis cet environnement : le nom d'image de DFSR (`dfsr.exe` d'apres le
 * chemin `%SystemRoot%\system32\DFSR.exe` d'une liste tierce) et celui du service LPD (`tcpsvcs.exe` n'a pu etre
 * verifie : l'ecoute 515 est attribuee au spouleur, le processus du role d'impression de la simulation).
 *
 * Ce qui est construit : `WindowsServicePortProjection` tient aussi les ecoutes de fonctionnalite -- 3389 (RDP active),
 * 5985 (WinRM configure), 389, 3268, 636 et 3269 (controleur de domaine, TLS implicite pour les deux derniers), 88,
 * 5722 (role DFS Replication), 8530 (role Update Services), 515 (role d'impression) et 135 (`RpcSs` demarre) -- chacune
 * avec un predicat d'activite et un proprietaire lu dans la table des processus (`lsass.exe`, `System`, l'hote de
 * `RpcSs`, de `TermService`, de `DFSR`, de `Spooler`) ; `initDefaultSockets` n'ouvre plus aucune ecoute ; elle est
 * rapprochee de l'etat a chaque evenement de service, a chaque ecriture du registre (quel qu'en soit le chemin), a chaque
 * changement de `WindowsWinRmConfig` (nouveau `onChange`), au cycle de vie des roles et a la promotion d'un controleur
 * de domaine ; RDP n'a plus qu'un interrupteur, la valeur de registre `fDenyTSConnections` (semee a 1, comme une
 * installation neuve) que `WindowsRdpConfig` lit et ecrit, et qui ferme RDP quand elle est absente ; `winrm
 * quickconfig` et `Enable-PSRemoting` demarrent le service `WinRM` en Automatic, comme `winrm quickconfig` l'annonce
 * (« WinRM service started ») ; `TermService` entre dans le gestionnaire de services et un svchost (PID 1096) l'heberge
 * dans la table des processus, de sorte que le PID d'RDP existe enfin dans `tasklist` et dans `sc queryex`.
 *
 * Ce qui n'est PAS construit : les ecoutes que les roles DNS, IIS, DHCP, NPS, Exchange et cluster ouvrent par leurs
 * propres sous-systemes gardent le PID 0 ; le port 135 d'une machine qui n'est pas controleur de domaine accepte puis
 * ferme (le mappeur RPC n'existe pas) ; `TermService` est affiche Automatic quand un Windows reel le dit Manual (le
 * demarrage de la machine ne connait pas les declencheurs) ; WinRM n'ouvre que son ecouteur HTTP 5985.
 *
 * Discrimination (fichier copie sur ce9f180db) : QUARANTE ET UN cas sur quarante-deux tombent ; le dernier est le TEMOIN
 * (sshd et le serveur SMB repondent, 135 est ouvert). Mutations, toutes tuees : sans rapprochement sur ecriture du
 * registre 4, sans abonnement a WinRM 1 ; sans demarrage du service WinRM 1 ; promotion sans rapprochement 5 ; roles
 * sans rapprochement 1 ; DFSR au noyau 1 ; LDAP au noyau 4 ; 135 reserve au controleur de domaine 2 ; RDP au noyau 2 ;
 * sans svchost de TermService 2 ; sans service TermService 1 ; roles toujours installes 11 ; toujours controleur de
 * domaine 10 ; RDP toujours actif 5 ; WinRM toujours actif 3 ; impression au noyau 1 ; RDP jamais actif 7 ; `enable`
 * qui ecrit 1 : 4 ; registre seme a 0 : 4 ; cle absente prise pour une autorisation : 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Lab<T extends WindowsPC> {
  readonly linux: LinuxPC;
  readonly windows: T;
  reach(port: number): Promise<'open' | 'refused' | 'accepted-then-closed'>;
}

async function lab<T extends WindowsPC>(windows: T): Promise<Lab<T>> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  return {
    linux, windows,
    reach: async (port) => {
      let opened = false;
      const socket = linux.getTcpStack().connect('10.0.0.7', port, { onOpen: () => { opened = true; } })!;
      await settle();
      if (!opened) return 'refused';
      if (socket.state !== 'established') return 'accepted-then-closed';
      socket.close();
      return 'open';
    },
  };
}

const client = () => lab(new WindowsPC('windows-pc', 'WIN', 100, 0));
const server = () => lab(new WindowsServer('SRV', 100, 0));

const powershell = (windows: WindowsPC, command: string) => windows.executeCommand(`powershell -Command "${command}"`);

async function listeningPid(windows: WindowsPC, port: number): Promise<number | null> {
  const row = (await windows.executeCommand('netstat -ano')).split('\n')
    .find((line) => new RegExp(`^\\s*TCP\\s+0\\.0\\.0\\.0:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+\\d+\\s*$`).test(line));
  return row ? Number(row.trim().split(/\s+/).pop()) : null;
}

async function imagePid(windows: WindowsPC, image: string): Promise<number | null> {
  const row = (await windows.executeCommand(`tasklist /FI "IMAGENAME eq ${image}"`)).split('\n')
    .find((line) => line.startsWith(image));
  return row ? Number(row.split(/\s+/)[1]) : null;
}

async function servicesOf(windows: WindowsPC, pid: number): Promise<string> {
  return windows.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`);
}

const FEATURE_PORTS = [3389, 5985, 389, 3268, 636, 3269, 88, 5722, 8530, 515];

async function installForest(srv: WindowsServer): Promise<void> {
  srv.getRoleManager().install('AD-Domain-Services');
  const result = srv.installADDSForest('lab.local', undefined, 'P@ssw0rd', { installDns: false });
  expect(result.ok).toBe(true);
}

describe('the bench is sound (witness)', () => {
  it('sshd and the SMB server answer, 135 is open on every Windows machine', async () => {
    const { windows, reach } = await client();
    expect(await reach(22)).toBe('open');
    expect(await reach(445)).toBe('open');
    expect(await reach(135)).not.toBe('refused');
    expect(await listeningPid(windows, 135)).not.toBeNull();
  });
});

describe('a port its feature does not serve is refused and absent from netstat', () => {
  it.each(FEATURE_PORTS.map((port) => [port]))('a default Windows client: %i', async (port) => {
    const { windows, reach } = await client();
    expect(await reach(port)).toBe('refused');
    expect(await listeningPid(windows, port)).toBeNull();
  });

  it.each(FEATURE_PORTS.map((port) => [port]))('a default Windows Server: %i', async (port) => {
    const { windows, reach } = await server();
    expect(await reach(port)).toBe('refused');
    expect(await listeningPid(windows, port)).toBeNull();
  });
});

describe('the feature opens its port at the PID of the process that serves it', () => {
  it('Enable-RemoteDesktop opens 3389 in the svchost that hosts TermService, Disable-RemoteDesktop closes it', async () => {
    const { windows, reach } = await server();
    await powershell(windows, 'Enable-RemoteDesktop');
    const pid = await listeningPid(windows, 3389);
    expect(pid).not.toBeNull();
    expect(await servicesOf(windows, pid!)).toMatch(/svchost\.exe\s+\d+\s+TermService/);
    expect(await reach(3389)).toBe('open');
    await powershell(windows, 'Disable-RemoteDesktop');
    expect(await reach(3389)).toBe('refused');
    expect(await listeningPid(windows, 3389)).toBeNull();
  });

  it.each([
    ['Set-ItemProperty from PowerShell', 'powershell -Command "Set-ItemProperty -Path \'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\' -Name fDenyTSConnections -Value 0"'],
    ['reg add from cmd', 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f'],
  ])('writing fDenyTSConnections = 0 with %s opens 3389, writing 1 closes it: the registry is the switch', async (_label, enable) => {
    const { windows, reach } = await server();
    expect(await windows.executeCommand('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections')).toMatch(/0x1/);
    await windows.executeCommand(enable);
    expect(await reach(3389)).toBe('open');
    await windows.executeCommand('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 1 /f');
    expect(await reach(3389)).toBe('refused');
  });

  it.each([
    ['the value', 'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /f'],
    ['the key', 'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /f'],
  ])('a registry without %s refuses RDP: the switch fails closed', async (_label, remove) => {
    const { windows, reach } = await server();
    await powershell(windows, 'Enable-RemoteDesktop');
    expect(await reach(3389)).toBe('open');
    await windows.executeCommand(remove);
    expect(await reach(3389)).toBe('refused');
  });

  it('Enable-RemoteDesktop writes the registry value and Disable-RemoteDesktop writes it back', async () => {
    const { windows } = await server();
    const query = () => windows.executeCommand('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections');
    await powershell(windows, 'Enable-RemoteDesktop');
    expect(await query()).toMatch(/0x0/);
    await powershell(windows, 'Disable-RemoteDesktop');
    expect(await query()).toMatch(/0x1/);
  });

  it('winrm quickconfig opens 5985 for the kernel (PID 4) and starts the WinRM service', async () => {
    const { windows, reach } = await client();
    expect(await windows.executeCommand('sc query WinRM')).toContain('STOPPED');
    await windows.executeCommand('winrm quickconfig');
    expect(await listeningPid(windows, 5985)).toBe(4);
    expect(await reach(5985)).toBe('open');
    expect(await windows.executeCommand('sc query WinRM')).toContain('RUNNING');
  });

  it('winrm quickconfig opens 5985 even when the WinRM service was already running, which alone opens nothing', async () => {
    const { windows, reach } = await client();
    await windows.executeCommand('sc start WinRM');
    expect(await reach(5985)).toBe('refused');
    await windows.executeCommand('winrm quickconfig');
    expect(await reach(5985)).toBe('open');
  });

  it('TermService is in the service controller and sc queryex names the svchost that holds 3389', async () => {
    const { windows } = await server();
    await powershell(windows, 'Enable-RemoteDesktop');
    const pid = await listeningPid(windows, 3389);
    expect(await windows.executeCommand('sc queryex TermService')).toMatch(new RegExp(`RUNNING[\\s\\S]*PID\\s*:\\s*${pid}\\b`));
  });

  it('Enable-PSRemoting opens 5985 the same way', async () => {
    const { windows, reach } = await client();
    await powershell(windows, 'Enable-PSRemoting -Force');
    expect(await listeningPid(windows, 5985)).toBe(4);
    expect(await reach(5985)).toBe('open');
  });

  it.each([[389], [3268], [636], [3269], [88]])('promoting a domain controller opens %i in lsass.exe', async (port) => {
    const { windows, reach } = await server();
    await installForest(windows);
    expect(await listeningPid(windows, port)).toBe(await imagePid(windows, 'lsass.exe'));
    expect(await listeningPid(windows, port)).not.toBeNull();
    expect(await reach(port)).toBe('open');
  });

  it('135 is held by the svchost that hosts RpcSs', async () => {
    const { windows } = await client();
    const pid = await listeningPid(windows, 135);
    expect(pid).not.toBeNull();
    expect(await servicesOf(windows, pid!)).toMatch(/svchost\.exe\s+\d+\s+RpcSs/);
  });

  it('installing DFS Replication opens 5722 at the PID of its process, removing it closes the port', async () => {
    const { windows, reach } = await server();
    await powershell(windows, 'Install-WindowsFeature FS-DFS-Replication');
    const pid = await listeningPid(windows, 5722);
    expect(pid).not.toBeNull();
    expect(await servicesOf(windows, pid!)).toContain('DFSR');
    expect(await reach(5722)).toBe('open');
    await powershell(windows, 'Uninstall-WindowsFeature FS-DFS-Replication');
    expect(await reach(5722)).toBe('refused');
    expect(await listeningPid(windows, 5722)).toBeNull();
  });

  it('installing Windows Server Update Services opens 8530 for the kernel (PID 4), removing it closes the port', async () => {
    const { windows, reach } = await server();
    await powershell(windows, 'Install-WindowsFeature UpdateServices');
    expect(await listeningPid(windows, 8530)).toBe(4);
    expect(await reach(8530)).toBe('open');
    await powershell(windows, 'Uninstall-WindowsFeature UpdateServices');
    expect(await reach(8530)).toBe('refused');
  });

  it('installing Print and Document Services opens 515 in the spooler process, removing it closes the port', async () => {
    const { windows, reach } = await server();
    await powershell(windows, 'Install-WindowsFeature Print-Services');
    expect(await listeningPid(windows, 515)).toBe(await imagePid(windows, 'spoolsv.exe'));
    expect(await reach(515)).toBe('open');
    await powershell(windows, 'Uninstall-WindowsFeature Print-Services');
    expect(await reach(515)).toBe('refused');
  });
});

describe('what netstat lists is what the network reaches, and every owner exists in tasklist', () => {
  it('a default Windows client: every listening row has a live owner and accepts', async () => {
    const { windows, reach } = await client();
    const rows = (await windows.executeCommand('netstat -ano')).split('\n')
      .filter((line) => /^\s*TCP\s+0\.0\.0\.0:\d+\s+0\.0\.0\.0:0\s+LISTENING/.test(line));
    expect(rows.length).toBeGreaterThan(2);
    const tasklist = await windows.executeCommand('tasklist');
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      const port = Number(fields[1].split(':')[1]);
      const pid = Number(fields[fields.length - 1]);
      expect(pid, row).not.toBe(0);
      expect(tasklist, row).toMatch(new RegExp(`\\s${pid}\\s+(Services|Console)`));
      expect(await reach(port), row).not.toBe('refused');
    }
  });

  it('a Windows Server with every feature on: the same invariant', async () => {
    const { windows, reach } = await server();
    await installForest(windows);
    await powershell(windows, 'Install-WindowsFeature FS-DFS-Replication');
    await powershell(windows, 'Install-WindowsFeature UpdateServices');
    await powershell(windows, 'Install-WindowsFeature Print-Services');
    await powershell(windows, 'Enable-RemoteDesktop');
    await windows.executeCommand('winrm quickconfig');
    const rows = (await windows.executeCommand('netstat -ano')).split('\n')
      .filter((line) => /^\s*TCP\s+0\.0\.0\.0:\d+\s+0\.0\.0\.0:0\s+LISTENING/.test(line));
    const ports = rows.map((row) => Number(row.trim().split(/\s+/)[1].split(':')[1]));
    for (const port of FEATURE_PORTS) expect(ports).toContain(port);
    const tasklist = await windows.executeCommand('tasklist');
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      const pid = Number(fields[fields.length - 1]);
      expect(pid, row).not.toBe(0);
      expect(tasklist, row).toMatch(new RegExp(`\\s${pid}\\s+(Services|Console)`));
      expect(await reach(Number(fields[1].split(':')[1])), row).not.toBe('refused');
    }
  });
});
