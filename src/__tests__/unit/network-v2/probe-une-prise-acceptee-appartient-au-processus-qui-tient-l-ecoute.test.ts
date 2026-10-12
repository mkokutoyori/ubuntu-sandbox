/**
 * La connexion qu'un service accepte appartient au processus qui tient son ecoute, comme le descripteur que rend
 * accept() : `ss -p`, `lsof` et `netstat -ano` la rattachent a ce processus, et quand il sort la connexion se ferme
 * au lieu de rester ouverte des deux cotes sans proprietaire.
 *
 * Mesure de depart (5df140bb3), deux LinuxPC cables, une ecoute sur 7000 dont l'identite nomme un processus
 * `daemon`, un client qui s'y connecte : `ss -tnp state established sport = :7000` listait la connexion acceptee
 * sans colonne `users:`, et `sudo kill <daemon>` la laissait ESTAB des deux cotes. Seuls sshd et telnetd
 * rattachaient leurs connexions a la main, dans leur `onAccept` : tout autre service avait une ecoute proprietaire
 * et des connexions orphelines. Sur un WindowsPC, la pile listait `22->10.0.0.3:32768 established owner=null` pour
 * une connexion acceptee par `sshd.exe` (PID 1088) : le processus n'avait aucun moyen de la fermer en mourant.
 *
 * Autorites : accept(2), page de manuel du noyau Linux (mkerrisk/man-pages) : accept « creates a new connected
 * socket, and returns a new file descriptor referring to that socket » -- un descripteur du processus qui appelle,
 * donc de celui qui tient l'ecoute ; Winsock `accept` (MicrosoftDocs/sdk-api) : « creates and returns a handle to
 * the new socket », qui garde les proprietes de l'ecoute.
 *
 * Ce qui est construit : `TcpStack.completePassiveOpen` pose le proprietaire de la prise acceptee d'apres
 * l'identite de l'ecoute (`setSocketOwner`, donc aussi la ligne de la table des sockets) avant de la remettre au
 * service ; les deux `setSocketOwner` manuels de sshd et de telnetd disparaissent ; un service qui change de
 * proprietaire, le moniteur de session d'un sshd, le fait toujours par `setSocketOwner`.
 *
 * Ce qui n'est PAS construit : un service dont plusieurs processus tiennent le meme descripteur d'ecoute (fork) ;
 * le proprietaire reste celui que nomme l'identite.
 *
 * Discrimination (fichier copie sur 5df140bb3) : TROIS cas sur cinq tombent. Les deux autres passent des deux
 * cotes : un TEMOIN (une ecoute qui ne nomme aucun processus laisse la connexion acceptee sans proprietaire,
 * l'heritage ne fabrique rien) et une NON-REGRESSION (une connexion que la machine ouvre elle-meme n'appartient pas
 * a son ecoute). Mutation : ne plus poser le proprietaire fait tomber les trois cas, et cinq de la sonde Windows
 * voisine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { spawnSocketOwner } from '../../support/socketOwner';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  readonly server: LinuxPC;
  readonly client: LinuxPC;
  readonly accepted: TcpSocket[];
  readonly daemonPid: number;
}

async function lab(withPid = true): Promise<Lab> {
  const server = new LinuxPC('linux-pc', 'SRV', 0, 0);
  const client = new LinuxPC('linux-pc', 'CLI', 100, 0);
  server.powerOn();
  client.powerOn();
  new Cable('c1').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ifconfig eth0 10.0.0.1');
  await client.executeCommand('ifconfig eth0 10.0.0.2');
  const daemonPid = spawnSocketOwner(server, 'daemon');
  const accepted: TcpSocket[] = [];
  server.getTcpStack().listen(7000, {
    identity: withPid ? { pid: daemonPid, processName: 'daemon' } : {},
    onAccept: (socket) => { accepted.push(socket); },
  });
  return { server, client, accepted, daemonPid };
}

describe('the connection a listener accepts belongs to the process that holds the listener', () => {
  it('ss -tnp names the daemon on the accepted connection', async () => {
    const { server, client, daemonPid } = await lab();
    client.getTcpStack().connect('10.0.0.1', 7000, {});
    await settle();
    const listing = await server.executeCommand('sudo ss -tnp state established sport = :7000');
    expect(listing).toContain('"daemon"');
    expect(listing).toContain(`pid=${daemonPid}`);
  });

  it('killing the daemon closes the connection it accepted, the peer is told', async () => {
    const { server, client, daemonPid } = await lab();
    const socket = client.getTcpStack().connect('10.0.0.1', 7000, {})!;
    const closed: string[] = [];
    socket.onClose((reason) => closed.push(reason));
    await settle();
    expect(socket.state).toBe('established');
    await server.executeCommand(`sudo kill ${daemonPid}`);
    await settle();
    expect(socket.state).not.toBe('established');
    expect(closed).toHaveLength(1);
  });

  it('WITNESS: a listener that names no process leaves the accepted connection ownerless', async () => {
    const { server, client } = await lab(false);
    client.getTcpStack().connect('10.0.0.1', 7000, {});
    await settle();
    const listing = await server.executeCommand('sudo ss -tnp state established sport = :7000');
    expect(listing).toContain('7000');
    expect(listing).not.toContain('users:');
  });

  it('a connection the machine opens itself does not belong to its listener', async () => {
    const { server, client, daemonPid } = await lab();
    client.getTcpStack().listen(7001, { onAccept: () => undefined });
    const outgoing = server.getTcpStack().connect('10.0.0.2', 7001, {})!;
    await settle();
    expect(outgoing.state).toBe('established');
    expect(outgoing.ownerPid).not.toBe(daemonPid);
  });

  it('Windows: the connection accepted by sshd.exe belongs to its process (PID 1088)', async () => {
    const client = new LinuxPC('linux-pc', 'CLI', 0, 0);
    const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
    client.powerOn();
    windows.powerOn();
    new Cable('c1').connect(client.getPort('eth0')!, windows.getPort('eth0')!);
    await client.executeCommand('ifconfig eth0 10.0.0.3');
    await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
    client.getTcpStack().connect('10.0.0.7', 22, {});
    await settle();
    const accepted = windows.getTcpStack().listSockets().filter((socket) => socket.passive && socket.localPort === 22);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].ownerPid).toBe(1088);
  });
});
