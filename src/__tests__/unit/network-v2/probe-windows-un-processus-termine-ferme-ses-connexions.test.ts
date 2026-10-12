/**
 * Un processus Windows que l'on arrete ferme les connexions qu'il tient, et `netstat -ano` comme
 * `Get-NetTCPConnection` listent les connexions vivantes avec le PID de leur proprietaire.
 *
 * Mesure de depart (5df140bb3), un LinuxPC et un WindowsPC cables, session Administrator. Une connexion ouverte sur
 * le 22 (`sshd.exe`, PID 1088) n'etait dans aucune des deux vues : elles lisaient la SocketTable, qui ne recevait que
 * les lignes d'ecoute, la pile du WindowsPC n'ayant pas la projection que LinuxMachine installe. `taskkill /F /PID
 * 1088` retirait la ligne d'ecoute et laissait la connexion ESTABLISHED des deux cotes, rien ne partait sur le fil :
 * le faucheur appelait `abortSocketsOwnedBy`, un `_teardown` silencieux sur des prises que personne ne possedait, puis
 * retirait toute ligne portant la meme adresse locale (celles des autres connexions du port) ou le meme nom d'image
 * (celles des autres instances de svchost.exe). `sc stop sshd` ne prevenait pas le pair non plus : le processus
 * quittait la table sans evenement. `Stop-Process` sans -Force n'etait pas une terminaison forcee, et `ssh` lance
 * depuis le poste Windows ecrivait une ligne TIME_WAIT fabriquee a la main (`10.0.0.7:55579`) alors que le serveur
 * avait vu le port 49153 sur le fil.
 *
 * Autorites (MicrosoftDocs/sdk-api et MicrosoftDocs/win32, sources lues) : `ExitProcess` -- « All of the object
 * handles opened by the process are closed » ; `TerminateProcess` -- « unconditionally cause a process to exit » et
 * « requests cancellation of all pending I/O » ; WSAECONNRESET -- la remise a zero « normally results if the peer
 * application on the remote host is suddenly stopped » ; `closesocket` -- sans SO_LINGER la fermeture est ordinaire
 * (« graceful »), et « any data queued for transmission will be sent, if possible » avant elle. La documentation
 * ne dit rien d'un RST sur des octets non lus : la fermeture ordinaire n'en emet pas.
 *
 * Ce qui est construit : la pile du WindowsPC projette ses connexions dans la table des sockets
 * (`TcpSocketStateProjection`, deplacee dans `tcp/` et partagee avec LinuxMachine), donc `netstat -ano` et
 * `Get-NetTCPConnection`, qui lisent la meme table, voient les connexions ; le faucheur de `windows.process.stopped`
 * ferme les prises du processus par `closeSocketsOwnedBy` (`reset` quand l'evenement porte `forced`, `graceful`
 * sinon), n'ote que la ligne d'une prise disparue, laisse en TIME_WAIT sans proprietaire (PID 0) celle qui survit,
 * et ne desinstalle que les ecoutes du processus -- par PID, le nom d'image ne servant que pour une ligne sans PID ;
 * `windows.process.stopped` porte `forced` (`taskkill /F`, `Stop-Process`, toujours TerminateProcess) ;
 * l'arret d'un service publie la fin de son processus ; `abortSocketsOwnedBy` et la ligne TIME_WAIT fabriquee de
 * `cmdSsh` disparaissent, la pile ecrit la seule ligne.
 *
 * Ce qui n'est PAS construit : `taskkill` sans /F demanderait la fermeture a une application a fenetre et refuserait
 * un processus de console (« This process can only be terminated forcefully ») ; ici le gestionnaire de processus
 * termine dans tous les cas.
 *
 * Discrimination (fichier copie sur 5df140bb3) : HUIT cas sur neuf tombent ; le neuvieme est le TEMOIN (l'ecoute de
 * sshd.exe affiche son PID et un client l'atteint). Mutations, toutes tuees : ne plus poser le proprietaire des
 * prises acceptees fait tomber 5 cas ; fermer toujours en ordinaire en fait tomber 3 ; toujours remettre a zero 2 ;
 * garder le proprietaire d'une prise qui survit 1 ; retirer les connexions par `unbind` 1 ; sans projection 4 ;
 * un arret de service sans evenement 2 ; `Stop-Process` non force 1 ; apparier par nom d'image meme avec un PID 1 ;
 * rendre la ligne TIME_WAIT fabriquee 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import type { TcpSocket } from '@/network/tcp/TcpStack';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
const SSHD_PID = 1088;

interface Lab {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  readonly closes: Map<TcpSocket, string[]>;
  connect(): TcpSocket;
}

async function lab(): Promise<Lab> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  const closes = new Map<TcpSocket, string[]>();
  return {
    linux, windows, closes,
    connect: () => {
      const socket = linux.getTcpStack().connect('10.0.0.7', 22, {})!;
      const reasons: string[] = [];
      closes.set(socket, reasons);
      socket.onClose((reason) => reasons.push(reason));
      return socket;
    },
  };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

async function established(windows: WindowsPC, command = 'netstat -ano'): Promise<string[]> {
  return (await windows.executeCommand(command)).split('\n').filter((line) => /ESTABLISHED|Established/.test(line));
}

describe('the bench is sound (witness)', () => {
  it('the listener of sshd.exe shows its PID and a client reaches it', async () => {
    const { windows, connect } = await lab();
    expect(await windows.executeCommand('netstat -ano')).toMatch(new RegExp(`0\\.0\\.0\\.0:22\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+${SSHD_PID}\\b`));
    const socket = connect();
    await settle();
    expect(socket.state).toBe('established');
  });
});

describe('netstat -ano and Get-NetTCPConnection list the live connections, with their owner', () => {
  it('the accepted connection carries the PID of sshd.exe in both views', async () => {
    const { windows, connect } = await lab();
    connect();
    await settle();
    const cmd = await established(windows);
    expect(cmd).toHaveLength(1);
    expect(cmd[0]).toMatch(new RegExp(`10\\.0\\.0\\.7:22\\s+10\\.0\\.0\\.3:\\d+\\s+ESTABLISHED\\s+${SSHD_PID}\\b`));
    const ps = await windows.executeCommand('powershell -Command "Get-NetTCPConnection -State Established | Format-List LocalPort,State,OwningProcess"');
    expect(ps).toMatch(/LocalPort\s*:\s*22\b/);
    expect(ps).toMatch(new RegExp(`OwningProcess\\s*:\\s*${SSHD_PID}\\b`));
  });
});

describe('a process that is stopped closes the connections it holds', () => {
  it('taskkill /F: the peer is reset and the connection leaves netstat', async () => {
    const { windows, connect, closes } = await lab();
    const socket = connect();
    await settle();
    expect(await windows.executeCommand(`taskkill /F /PID ${SSHD_PID}`)).toContain('SUCCESS');
    await settle();
    expect(socket.state).toBe('closed');
    expect(closes.get(socket)).toEqual(['rst']);
    expect(await established(windows)).toEqual([]);
  });

  it('Stop-Process is TerminateProcess: the peer is reset too, with or without -Force', async () => {
    const { windows, connect, closes } = await lab();
    const socket = connect();
    await settle();
    await windows.executeCommand(`powershell -Command "Stop-Process -Id ${SSHD_PID}"`);
    await settle();
    expect(closes.get(socket)).toEqual(['rst']);
  });

  it('sc stop sshd: the service closes its connections in order, the peer is told with a FIN', async () => {
    const { windows, connect, closes, linux } = await lab();
    const socket = connect();
    await settle();
    await windows.executeCommand('sc stop sshd');
    await settle();
    expect(closes.get(socket)).toEqual(['fin']);
    expect(linux.getTcpStack().listSockets().filter((candidate) => candidate.remotePort === 22)).toEqual([]);
    expect(await established(windows)).toEqual([]);
  });

  it('what is left in TIME_WAIT belongs to nobody: PID 0 in netstat -ano', async () => {
    const { windows, connect } = await lab();
    connect();
    await settle();
    await windows.executeCommand('sc stop sshd');
    await settle();
    const rows = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => line.includes('TIME_WAIT'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/10\.0\.0\.7:22\s+10\.0\.0\.3:\d+\s+TIME_WAIT\s+0\s*$/);
  });

  it('the death of another process leaves the connection of sshd.exe and its listener alone', async () => {
    const { windows, connect, closes } = await lab();
    const socket = connect();
    await settle();
    const other = windows.getTcpStack().listSockets().find((candidate) => candidate.passive)!;
    windows.getTcpStack().setSocketOwner(other, 5120);
    const second = connect();
    await settle();
    await windows.executeCommand('taskkill /F /PID 5120');
    await settle();
    expect(closes.get(socket)).toEqual(['rst']);
    expect(second.state).toBe('established');
    expect(closes.get(second)).toEqual([]);
    const rows = await established(windows);
    expect(rows).toHaveLength(1);
    expect(await windows.executeCommand('netstat -ano')).toContain('0.0.0.0:22');
  });

  it('the TIME_WAIT left by an ssh command the Windows host ran carries the port the server saw', async () => {
    const { windows, linux } = await lab();
    await windows.executeCommand('ssh -o StrictHostKeyChecking=accept-new user@10.0.0.3 hostname', 'admin\n');
    await settle();
    const rows = (await windows.executeCommand('netstat -ano')).split('\n')
      .filter((line) => /10\.0\.0\.3:22\s+TIME_WAIT/.test(line));
    expect(rows).toHaveLength(1);
    const clientPort = /10\.0\.0\.7:(\d+)/.exec(rows[0])![1];
    const journal = await linux.executeCommand('sudo cat /var/log/auth.log');
    expect(journal).toContain(`Accepted password for user from 10.0.0.7 port ${clientPort}`);
  });

  it('the death of one instance of an image leaves the listeners of the other instances alone', async () => {
    const { windows } = await lab();
    const manager = (windows as unknown as { procMgr: { spawnProcess(name: string, ppid: number, owner: string): { pid: number } } }).procMgr;
    const first = manager.spawnProcess('worker.exe', 620, 'NT AUTHORITY\\SYSTEM').pid;
    const second = manager.spawnProcess('worker.exe', 620, 'NT AUTHORITY\\SYSTEM').pid;
    windows.getTcpStack().listen(7001, { identity: { pid: first, processName: 'worker.exe' }, onAccept: () => undefined });
    windows.getTcpStack().listen(7002, { identity: { pid: second, processName: 'worker.exe' }, onAccept: () => undefined });
    expect(await windows.executeCommand('netstat -ano')).toMatch(new RegExp(`0\\.0\\.0\\.0:7002\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+${second}\\b`));
    await windows.executeCommand(`taskkill /F /PID ${first}`);
    const listing = await windows.executeCommand('netstat -ano');
    expect(listing).not.toContain(':7001');
    expect(listing).toMatch(new RegExp(`0\\.0\\.0\\.0:7002\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+${second}\\b`));
  });
});
