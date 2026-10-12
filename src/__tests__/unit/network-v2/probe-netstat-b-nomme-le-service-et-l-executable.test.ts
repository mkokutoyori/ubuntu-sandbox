/**
 * `netstat -b` nomme sous chaque ligne le service puis l'executable qui tient la prise, comme le vrai, et demande une
 * session elevee ; le service qui tient une prise voyage de la socket jusqu'a la table, ou `netstat` et les autres vues
 * le lisent.
 *
 * Mesure de depart (fa7d49a31) : `netstat -b` imprimait le meme tableau que `netstat`, sans une ligne de plus, qu'on
 * soit administrateur ou utilisateur ordinaire ; la table des sockets ne savait que le processus qui tient une prise,
 * jamais le service : `-b` n'avait aucun moyen de dire `Dnscache`, `W32Time` ou `iphlpsvc` plutot que `svchost.exe`.
 *
 * Autorites : Microsoft Learn (`netstat -b`) pour le sens de l'option (l'executable, les composants appeles, le nom de
 * l'executable entre crochets en bas, option longue qui echoue sans les droits) ; des transcriptions de `netstat -bano`
 * (BleepingComputer, geekflare) pour la forme des lignes (`  RpcSs` puis ` [svchost.exe]`, ` Can not obtain ownership
 * information` pour System et pour un PID 0) ; le message `The requested operation requires elevation.` pour un
 * utilisateur sans droits. Non confirme depuis cet environnement : que l'entete `Active Connections` precede ou non ce
 * message (la simulation imprime le message seul) ; la forme de la chaine de composants pour un service qui en appelle
 * plusieurs (la simulation en met un, le service).
 *
 * Ce qui est construit : `ListenerIdentity.service`, `SocketEntry.serviceName`, `TcpListener` et
 * `TcpSocket.ownerService` (donc l'evenement `tcp.socket.owned` porte le service et la connexion acceptee le herite),
 * `EndHost.udpBind(..., { service })`, `WindowsProcessManager.identityOfService` qui donne le service avec le PID, et
 * les sites d'ouverture de DNS, DHCP, NPS, cluster, DHCPv6, mDNS/LLMNR, NTP et du port proxy qui le transmettent ;
 * `NetstatMachine.processImage(pid)` lit la table des processus, la meme que `tasklist`.
 *
 * Discrimination (fichier copie sur fa7d49a31) : TREIZE cas sur quinze tombent. Les deux autres passent des deux cotes :
 * le temoin et la non-regression d'un utilisateur ordinaire qui garde la liste sans `-b`. Mutations, toutes tuees (21) :
 * elevation ignoree 1, ligne de service pour tout executable 2, System avec un proprietaire 2, service apres
 * l'executable 8, aucune ligne de composant 11, ligne sans proprietaire supprimee 3, service jamais nomme 8, PID 0 avec
 * un proprietaire 1 ; service perdu a l'annonce de l'ecoute 4, service perdu pour l'UDP 5, connexion acceptee sans le
 * service 1, evenement de propriete sans le service 1, identite sans service 9, connexion relayee du port proxy sans
 * etiquette 1, DHCP sans service 1, NTP sans service 3, repondeurs du resolveur sans etiquette 3, proprietaire de
 * connexion qui efface le service 1, liaison UDP sans service 8 ; image du processus morte 9, toujours elevee 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Bench {
  readonly linux: LinuxPC;
  readonly win: WindowsServer;
}

async function bench(user = 'Administrator'): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const win = new WindowsServer('SRV', 100, 0);
  linux.powerOn();
  win.powerOn();
  win.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, win.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  win.setCurrentUser(user);
  return { linux, win };
}

const powershell = (win: WindowsServer, line: string) => PowerShellSubShell.create(win).subShell.processLine(line);

function blockOf(output: string, pattern: RegExp): string[] {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => /^\s*(TCP|UDP)\s/.test(line) && pattern.test(line));
  if (start === -1) return ['<absent>'];
  let end = start + 1;
  while (end < lines.length && !/^\s*(TCP|UDP)\s/.test(lines[end])) end++;
  return lines.slice(start, end).slice(1);
}

describe('the bench is sound (witness)', () => {
  it('-ano still prints the owner pid of the RPC endpoint mapper', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -ano')).toMatch(/^ {2}TCP {4}0\.0\.0\.0:135 {12}0\.0\.0\.0:0 {14}LISTENING {7}784$/m);
  });
});

describe('netstat -b needs an elevated session', () => {
  it('a standard user gets the refusal of the real tool and no table', async () => {
    const { win } = await bench('User');
    expect(await win.executeCommand('netstat -b')).toBe('The requested operation requires elevation.');
  });

  it('a standard user keeps the listing without -b', async () => {
    const { win } = await bench('User');
    expect(await win.executeCommand('netstat -ano')).toContain('Active Connections');
  });
});

describe('the lines that follow a row', () => {
  it('a service that runs in a svchost is named, and the executable comes last between brackets', async () => {
    const { win } = await bench();
    expect(blockOf(await win.executeCommand('netstat -anb'), /0\.0\.0\.0:135\s/)).toEqual(['  RpcSs', ' [svchost.exe]']);
  });

  it('two services hosted by svchost.exe are told apart', async () => {
    const { win } = await bench();
    const output = await win.executeCommand('netstat -anb');
    expect(blockOf(output, /UDP\s+0\.0\.0\.0:5355\s/)).toEqual(['  Dnscache', ' [svchost.exe]']);
    expect(blockOf(output, /UDP\s+0\.0\.0\.0:123\s/)).toEqual(['  W32Time', ' [svchost.exe]']);
  });

  it('a port proxy rule is the IP Helper service, in the svchost that hosts Schedule and LanmanServer', async () => {
    const { win } = await bench();
    await win.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    expect(blockOf(await win.executeCommand('netstat -anb'), /0\.0\.0\.0:8080\s/)).toEqual(['  iphlpsvc', ' [svchost.exe]']);
  });

  it('a service with its own process shows only the executable', async () => {
    const { win } = await bench();
    expect(blockOf(await win.executeCommand('netstat -anb'), /0\.0\.0\.0:22\s/)).toEqual([' [sshd.exe]']);
  });

  it('what the kernel owns has no ownership information, as the real tool says', async () => {
    const { win } = await bench();
    expect(blockOf(await win.executeCommand('netstat -anb'), /0\.0\.0\.0:445\s/)).toEqual([' Can not obtain ownership information']);
  });

  it('a connection in TIME_WAIT, which belongs to no process, has no ownership information either', async () => {
    const { win } = await bench();
    const socket = win.getTcpStack().connect('10.0.0.3', 22, {})!;
    await settle();
    socket.close();
    await settle();
    expect(blockOf(await win.executeCommand('netstat -anb'), /TIME_WAIT/)).toEqual([' Can not obtain ownership information']);
  });

  it('a connection accepted by a service, and the one it opens on its behalf, carry the service', async () => {
    const { linux, win } = await bench();
    linux.getTcpStack().listen(80, { onAccept: () => undefined });
    await win.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    const client = linux.getTcpStack().connect('10.0.0.7', 8080, {})!;
    await settle();
    const output = await win.executeCommand('netstat -anb');
    expect(blockOf(output, /10\.0\.0\.7:8080\s+10\.0\.0\.3:\d+\s+ESTABLISHED/)).toEqual(['  iphlpsvc', ' [svchost.exe]']);
    expect(blockOf(output, /10\.0\.0\.3:80\s+ESTABLISHED/)).toEqual(['  iphlpsvc', ' [svchost.exe]']);
    client.close();
  });

  it('-o and -b together keep the PID column and the lines below', async () => {
    const { win } = await bench();
    const output = await win.executeCommand('netstat -anob');
    expect(output).toContain('  Proto  Local Address          Foreign Address        State           PID');
    expect(output).toMatch(/^ {2}TCP {4}0\.0\.0\.0:135 {12}0\.0\.0\.0:0 {14}LISTENING {7}784\n {2}RpcSs\n \[svchost\.exe\]$/m);
  });

  it('the service named under a row is one of the services tasklist /svc lists for that pid', async () => {
    const { win } = await bench();
    const output = await win.executeCommand('netstat -anob');
    const lines = output.split('\n');
    const checked: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const pid = /^\s*(?:TCP|UDP)\s.*?(\d+)$/.exec(lines[index])?.[1];
      const service = /^ {2}(\w+)$/.exec(lines[index + 1] ?? '')?.[1];
      if (pid === undefined || service === undefined) continue;
      const tasks = await win.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`);
      expect(tasks).toContain(service);
      checked.push(service);
    }
    expect(checked).toEqual(expect.arrayContaining(['RpcSs', 'Dnscache', 'W32Time']));
  });

  it('after the service restarts the rows show the process that hosts it now', async () => {
    const { win } = await bench();
    await win.executeCommand('sc stop Dnscache');
    await win.executeCommand('sc start Dnscache');
    expect(blockOf(await win.executeCommand('netstat -anb'), /UDP\s+0\.0\.0\.0:5355\s/)).toEqual(['  Dnscache', ' [svchost.exe]']);
  });

  it('the roles of a server: the directory in no svchost, DHCP in one, IIS at the kernel', async () => {
    const { win } = await bench();
    await powershell(win, 'Install-WindowsFeature DNS');
    await powershell(win, 'Install-WindowsFeature DHCP');
    await powershell(win, 'Install-WindowsFeature Web-Server');
    const output = await win.executeCommand('netstat -anb');
    expect(blockOf(output, /TCP\s+0\.0\.0\.0:53\s/)).toEqual([' [dns.exe]']);
    expect(blockOf(output, /UDP\s+0\.0\.0\.0:67\s/)).toEqual(['  DHCPServer', ' [svchost.exe]']);
    expect(blockOf(output, /TCP\s+0\.0\.0\.0:80\s/)).toEqual([' Can not obtain ownership information']);
  });
});

describe('the other views carry the same fact', () => {
  it('the listener rows of the socket table name the service that owns them', async () => {
    const { win } = await bench();
    const row = (port: number) => win.getSocketTable().getAll().find((entry) => entry.protocol === 'udp' && entry.localPort === port);
    expect(row(5355)?.serviceName).toBe('Dnscache');
    expect(row(123)?.serviceName).toBe('W32Time');
  });
});
