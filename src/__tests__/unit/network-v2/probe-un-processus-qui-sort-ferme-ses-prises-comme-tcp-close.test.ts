/**
 * Un processus qui sort ferme ses prises comme le fait tcp_close() du noyau, il ne les fait pas disparaitre en
 * silence : un FIN si rien n'attendait d'etre lu, un RST s'il restait des octets recus et non lus, rien pour une
 * connexion qui n'est pas encore ouverte ; et une prise en TIME-WAIT, qui n'appartient plus a personne, survit a
 * son ancien proprietaire, avec sa ligne dans `ss`.
 *
 * Mesure de depart (608f58462 + les deux lots des processus ssh), deux LinuxPC cables, A ecoute sur 7000, B s'y
 * connecte, un processus `worker` tient la prise acceptee de A, `sudo kill <worker>` : A n'emettait aucune trame,
 * sa prise passait a `closed` et celle de B restait ESTAB (`ss -tan` de B : `ESTAB 10.0.0.2:32768 10.0.0.1:7000`)
 * sans fin, une connexion a moitie ouverte creee par un `kill` propre ; avec des octets non lus, le meme silence ;
 * une prise TIME-WAIT dont le proprietaire etait tue disparaissait. Le faucheur de sockets de `LinuxMachine`
 * appelait `abortSocketsOwnedBy`, qui ne fait que `_teardown`, et retirait aussi la ligne de la table des sockets
 * d'une prise qui restait dans la pile (FIN-WAIT, TIME-WAIT) : la pile la tenait, `ss` ne la montrait plus.
 *
 * Autorites : noyau v5.15, net/ipv4/tcp.c, source lue (`__tcp_close`, lignes 2705 a 2790) : les octets non lus
 * de la file de reception sont comptes (`data_was_unread`) ; s'il y en a, l'etat passe a CLOSE et
 * `tcp_send_active_reset` emet le RST (« As outlined in RFC 2525, section 2.17, we send a RST here because data
 * was lost ») ; sinon `tcp_close_state` puis `tcp_send_fin` (ESTABLISHED -> FIN_WAIT1, CLOSE_WAIT -> LAST_ACK) ;
 * RFC 9293 §3.6.1 (SHLD-3, pour le RST sur donnees en attente) et §3.10.4, CLOSE en SYN-SENT : le TCB est supprime
 * sans rien emettre.
 *
 * Ce qui est construit : `TcpStack.closeSocketsOwnedBy(pid)` (RST par `_abort` s'il y a des octets non lus, sinon
 * le CLOSE ordinaire de la pile, qui laisse tels quels TIME-WAIT et les etats deja en cours de fermeture, puis
 * l'application de la prise est prevenue une seule fois : le demon dont le processus sort sait que sa connexion est
 * finie) ; le faucheur de `LinuxMachine` ferme d'abord les prises du processus, retire la ligne d'une prise disparue
 * et ne fait que retirer le proprietaire (pid, nom, uid) de celle qui survit. La fin d'une session sshd dont le
 * processus est tue est le sujet de `probe-tuer-le-processus-de-session-termine-la-session`.
 *
 * Ce qui n'est PAS construit : `WindowsPC` garde `abortSocketsOwnedBy` (silencieux), la maniere dont Windows ferme
 * les connexions d'un processus termine n'etant pas sourcable d'ici ; SO_LINGER a zero ; le partage d'une prise
 * entre deux processus (le noyau ne ferme qu'au dernier descripteur).
 *
 * Discrimination (fichier copie sur 608f58462 + les deux lots, `git stash push -- src/network`) : SIX cas sur huit
 * tombent. Les deux autres passent des deux cotes : un TEMOIN (un proprietaire qui reste en vie ne change rien) et
 * une NON-REGRESSION (une connexion en SYN-SENT est supprimee sans RST, ce que la pile faisait deja). Mutations :
 * ignorer les octets non lus (toujours FIN) fait tomber 1 cas ; toujours reinitialiser en fait tomber 4 ; retirer
 * toujours la ligne en fait tomber 1 ; fermer les prises de tous les processus en fait tomber 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask, type EthernetFrame, type IPv4Packet } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { Cable } from '@/network/hardware/Cable';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TcpSegment } from '@/network/tcp/types';
import { framesSentOn } from '../../support/wireWatch';
import { spawnSocketOwner } from '../../support/socketOwner';
import { lettersOf } from '../../support/tcpScriptedPeer';

const SERVER_IP = '10.0.0.1';
const CLIENT_IP = '10.0.0.2';
const PORT = 7000;

interface Lab {
  readonly server: LinuxPC;
  readonly client: LinuxPC;
  readonly accepted: TcpSocket[];
  readonly sent: EthernetFrame[];
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

function lab(allowHalfOpen = false): Lab {
  const server = new LinuxPC('linux-pc', 'S');
  const client = new LinuxPC('linux-pc', 'C');
  new Cable('c1').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  server.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  client.configureInterface('eth0', new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
  const accepted: TcpSocket[] = [];
  server.getTcpStack().listen(PORT, { onAccept: (socket) => { accepted.push(socket); }, allowHalfOpen });
  return { server, client, accepted, sent: framesSentOn(server, 'eth0') };
}

function segmentsOf(frames: EthernetFrame[]): string[] {
  return frames.flatMap((frame) => {
    const packet = frame.payload as IPv4Packet;
    return (packet as { protocol?: number }).protocol === 6
      ? [lettersOf((packet.payload as unknown as TcpSegment).flags)]
      : [];
  });
}

function ownedBy(lab: Lab, socket: TcpSocket, name = 'worker'): number {
  const pid = spawnSocketOwner(lab.server, name);
  lab.server.getTcpStack().setSocketOwner(socket, pid);
  return pid;
}

async function rows(machine: LinuxPC): Promise<string[]> {
  return (await machine.executeCommand('ss -tan')).split('\n').filter((line) => line.includes(`:${PORT}`) && !line.startsWith('LISTEN'));
}

describe('the bench is sound (witnesses)', () => {
  it('a connection carries data, and an owner that stays alive changes nothing', async () => {
    const bench = lab();
    const clientSocket = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const received: string[] = [];
    bench.accepted[0].onData((data) => { received.push(String(data)); });
    clientSocket.write('hello');
    ownedBy(bench, bench.accepted[0]);
    expect(received.join('')).toBe('hello');
    expect(clientSocket.state).toBe('established');
    expect(bench.accepted[0].state).toBe('established');
  });
});

describe('a process that exits closes its sockets the way tcp_close does', () => {
  it('nothing unread: a FIN goes out, no reset, and the peer is told the connection is closing', async () => {
    const bench = lab();
    const clientSocket = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const pid = ownedBy(bench, bench.accepted[0]);
    bench.sent.length = 0;
    await bench.server.executeCommand(`sudo kill ${pid}`);
    const letters = segmentsOf(bench.sent);
    expect(letters).toContain('FA');
    expect(letters.some((flags) => flags.includes('R'))).toBe(false);
    expect(clientSocket.state).toBe('close-wait');
    expect((await rows(bench.client)).join('\n')).toContain('CLOSE-WAIT');
    expect(bench.accepted[0].state).toBe('fin-wait-2');
  });

  it('unread data in the receive queue: a reset goes out instead and the peer loses the connection', async () => {
    const bench = lab();
    const clientSocket = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    bench.accepted[0].pause();
    clientSocket.write('hello');
    const pid = ownedBy(bench, bench.accepted[0]);
    bench.sent.length = 0;
    await bench.server.executeCommand(`sudo kill ${pid}`);
    expect(segmentsOf(bench.sent).some((flags) => flags.includes('R'))).toBe(true);
    expect(clientSocket.state).toBe('closed');
    expect(await rows(bench.client)).toEqual([]);
    expect(await rows(bench.server)).toEqual([]);
  });

  it('a socket already in CLOSE-WAIT answers with its FIN and waits for the last ACK', async () => {
    const bench = lab(true);
    const clientSocket = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const pid = ownedBy(bench, bench.accepted[0]);
    clientSocket.close();
    expect(bench.accepted[0].state).toBe('close-wait');
    bench.sent.length = 0;
    await bench.server.executeCommand(`sudo kill ${pid}`);
    expect(segmentsOf(bench.sent)).toContain('FA');
    expect(bench.accepted[0].state).toBe('closed');
    expect(clientSocket.state).toBe('time-wait');
  });

  it('a TIME-WAIT socket is not a process one: it outlives its former owner', async () => {
    const bench = lab();
    const clientSocket = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const pid = ownedBy(bench, bench.accepted[0]);
    bench.accepted[0].close();
    expect(clientSocket.state).toBe('close-wait');
    clientSocket.close();
    expect(bench.accepted[0].state).toBe('time-wait');
    await bench.server.executeCommand(`sudo kill ${pid}`);
    expect(bench.accepted[0].state).toBe('time-wait');
    expect((await rows(bench.server)).join('\n')).toContain('TIME-WAIT');
  });

  it('a connection still being opened is dropped without a reset, and its port is free again', async () => {
    const bench = lab();
    const stack = bench.server.getTcpStack();
    const pending = stack.connect('10.0.0.77', PORT)!;
    expect(pending.state).toBe('syn-sent');
    const pid = spawnSocketOwner(bench.server, 'worker');
    stack.setSocketOwner(pending, pid);
    bench.sent.length = 0;
    await bench.server.executeCommand(`sudo kill ${pid}`);
    expect(pending.state).toBe('closed');
    expect(segmentsOf(bench.sent).some((flags) => flags.includes('R'))).toBe(false);
  });

  it('another process keeps its connection when this one exits', async () => {
    const bench = lab();
    const first = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const second = bench.client.getTcpStack().connect(SERVER_IP, PORT, { allowHalfOpen: true })!;
    const pidFirst = ownedBy(bench, bench.accepted[0], 'worker-a');
    ownedBy(bench, bench.accepted[1], 'worker-b');
    await bench.server.executeCommand(`sudo kill ${pidFirst}`);
    expect(first.state).toBe('close-wait');
    expect(second.state).toBe('established');
    expect(bench.accepted[1].state).toBe('established');
  });
});

describe('end to end: the process that holds an ssh session is killed on the server', () => {
  const key = (name: string): KeyEvent =>
    ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

  async function flush(times = 30): Promise<void> {
    for (let round = 0; round < times; round += 1) {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  it('the client hears the FIN: its terminal is hung up, its ssh process retires, the server keeps a TIME-WAIT with no owner', async () => {
    const client = new LinuxPC('linux-pc', 'CLI');
    const server = new LinuxServer('linux-server', 'SRV');
    const switchBox = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    client.configureInterface('eth0', new IPAddress('10.0.9.1'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.9.2'), new SubnetMask('255.255.255.0'));
    new Cable('e1').connect(client.getPort('eth0')!, switchBox.getPorts()[0]);
    new Cable('e2').connect(server.getPort('eth0')!, switchBox.getPorts()[1]);
    await server.executeCommand('useradd -m alice');
    await server.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');
    const terminal = new LinuxTerminalSession('t', client);
    await terminal.init();
    terminal.setInput('ssh -o StrictHostKeyChecking=accept-new alice@10.0.9.2');
    terminal.handleKey(key('Enter'));
    await flush();
    terminal.setPasswordBuf('secret');
    terminal.handleKey(key('Enter'));
    await flush();
    const clientPs = async (): Promise<string> => client.executeCommand('ps -ww -eo pid,comm,args');
    expect(await clientPs()).toMatch(/\bssh\b.*alice@10\.0\.9\.2/);
    const monitor = /^\s*(\d+)\s+\d+\s+root\s+\?\s+sshd\s+sshd: alice \[priv\]/m
      .exec(await server.executeCommand('ps -ww -eo pid,ppid,user,tty,comm,args'))?.[1];
    expect(monitor).toBeDefined();
    await server.executeCommand(`sudo kill ${monitor}`);
    await flush();
    const lines = terminal.lines.map((line) => (typeof line === 'string' ? line : line.text ?? ''));
    expect(lines.join('\n')).toContain('Connection to 10.0.9.2 closed');
    expect(await clientPs()).not.toMatch(/\bssh\b.*alice@10\.0\.9\.2/);
    expect(await client.executeCommand('ss -tan dport = :22')).not.toContain('ESTAB');
    const waiting = (await server.executeCommand('sudo ss -tanp sport = :22')).split('\n')
      .filter((line) => line.includes('TIME-WAIT'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).not.toContain('users:');
  });
});
