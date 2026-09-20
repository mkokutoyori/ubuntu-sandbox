/*
 * Nagle est un algorithme de COALESCENCE, pas seulement de retenue.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Chaque `send()` decoupait ses octets et EMPILAIT ses morceaux sur
 * `sendBacklog` sans jamais regarder ce qui s'y trouvait deja. Six
 * ecritures de 5 octets derriere une fenetre FERMEE laissaient donc six
 * entrees distinctes, et a la reouverture la mesure comptait SEPT
 * segments — `[1,4,5,5,5,5,5]` — pour 30 octets de donnees. Un flux TCP
 * n'a pourtant pas de frontieres de message : ces 30 octets sont un seul
 * segment.
 *
 * La retenue manquait aussi. Trois ecritures emises depuis `onData`,
 * donc a l'interieur de la rafale du pair et avant que son ACK ne
 * revienne, donnaient `[1,1,3]` : trois segments nains alors que les
 * deux derniers auraient du attendre l'acquittement du premier.
 *
 * ── L'autorite ──────────────────────────────────────────────────────
 *
 * RFC 9293 §3.7.4 : « If there is unacknowledged data (i.e., SND.NXT >
 * SND.UNA), then the sending TCP endpoint buffers all user data
 * (regardless of the PSH bit) until the outstanding data has been
 * acknowledged or until the TCP endpoint can send a full-sized segment
 * (Eff.snd.MSS bytes). » La meme section fait de la DESACTIVATION un
 * MUST : « applications that require low latency on every packet sent
 * MUST be provided with a mechanism to disable Nagle ».
 *
 * ── LE PIEGE, ET POURQUOI LA BORNE SE LIT SUR LA FILE ───────────────
 *
 * « can send a full-sized segment » se lit de deux facons et une seule
 * est sure. Mesuree sur la FENETRE, une fenetre annoncee de 128 octets
 * maintient tout morceau sous la taille pleine pour toujours : la
 * retenue ne se leve jamais et un transfert de 20 000 octets se bloque
 * net. Mesuree sur la FILE, elle se leve des que l'application a de quoi
 * remplir un segment. Une fenetre aussi petite releve du controle de
 * flux et du minuteur de persistance, jamais de Nagle. Le temoin de la
 * fenetre de 128 octets est dans ce fichier pour cette raison : c'est
 * exactement le cas qui avait fait ABANDONNER une premiere tentative.
 *
 * ── CE QUE NAGLE NE FAIT PAS ICI, ET C'EST CORRECT ──────────────────
 *
 * Trois `send('X')` consecutifs donnent toujours `[1,1,1]`. Le RTT est
 * nul dans ce simulateur et le drain de fin de rafale rend l'ACK avant
 * que l'ecriture suivante ne parte : il n'y a donc JAMAIS de donnee non
 * acquittee au moment ou l'application ecrit a nouveau, et la porte de
 * Nagle est legitimement ouverte. Un temoin l'affirme plutot que de le
 * taire, parce que c'est precisement ce qu'on croirait casse.
 *
 * ── Discrimination (`git stash` de `TcpStack.ts`) ───────────────────
 *
 * CINQ cas sur neuf tombent : la coalescence derriere fenetre fermee
 * (sept segments contre deux), le nombre d'entrees de la file (six
 * contre une), la retenue dans la rafale (`[1,1,3]` contre `[1,4]`), la
 * coalescence d'octets binaires, et `TCP_NODELAY` — ce dernier par
 * absence de l'API, qui n'existait pas.
 *
 * Les QUATRE autres sont des TEMOINS et passent des deux cotes : le
 * transfert en vrac inchange, qui prouve que le laboratoire tient ; la
 * fenetre plus petite que le MSS, non-regression contre l'interblocage ;
 * `close()` qui ne doit rien laisser derriere le FIN ; et les ecritures
 * sur connexion au repos, qui documentent la porte ouverte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TCP_INITIAL_RTO_MS } from '@/network/tcp/RttEstimator';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TcpSegmentSentPayload } from '@/network/tcp/events';

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildPair() {
  const bus = new EventBus();
  const client = new LinuxPC('CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  client.setEventBus(bus); server.setEventBus(bus);
  client.powerOn(); server.powerOn();
  const cable = new Cable('a');
  cable.setEventBus(bus);
  cable.connect(client.getPort('eth0')!, server.getPort('eth0')!);
  client.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  const scheduler = new VirtualTimeScheduler();
  client.setScheduler(scheduler);
  server.setScheduler(scheduler);
  return { client, server, bus, scheduler };
}

function dataSizesFrom(bus: EventBus, sourceIp: string): number[] {
  const sizes: number[] = [];
  bus.subscribe('tcp.segment.sent', (e) => {
    const p = e.payload as TcpSegmentSentPayload;
    if (p.sourceIp === sourceIp && p.payloadSize > 0) sizes.push(p.payloadSize);
  });
  return sizes;
}

function replyingLab(port: number, reply: (peer: TcpSocket) => void) {
  const lab = buildPair();
  let accepted: TcpSocket | null = null;
  lab.server.getTcpStack().listen(port, {
    onAccept: (s) => {
      accepted = s;
      s.onData(() => reply(s));
    },
  });
  const socket = lab.client.getTcpStack().connect(SERVER_IP, port)!;
  socket.onData(() => {});
  return { ...lab, socket, accepted: () => accepted };
}

describe('TCP Nagle (RFC 9293 §3.7.4)', () => {
  it('coalesces writes that queued behind a closed window into one segment', () => {
    const { client, server, bus, scheduler } = buildPair();
    let accepted: TcpSocket | null = null;
    const received: string[] = [];
    server.getTcpStack().listen(7900, {
      onAccept: (s) => { accepted = s; s.windowSize = 0; s.onData((d) => received.push(d as string)); },
    });
    const socket = client.getTcpStack().connect(SERVER_IP, 7900)!;
    const sizes = dataSizesFrom(bus, CLIENT_IP);

    for (let i = 0; i < 6; i++) socket.send('abcde');
    accepted!.windowSize = 64240;
    scheduler.advance(TCP_INITIAL_RTO_MS + 10);

    expect(sizes).toEqual([1, 29]);
    expect(received.join('')).toBe('abcde'.repeat(6));
  });

  it('queues one coalesced entry, not a run of runts', () => {
    const { client, server } = buildPair();
    server.getTcpStack().listen(7901, { onAccept: (s) => { s.windowSize = 0; } });
    const socket = client.getTcpStack().connect(SERVER_IP, 7901)!;

    for (let i = 0; i < 6; i++) socket.send('abcde');

    expect(socket.sendBacklog.length).toBe(1);
    expect(socket.sendBacklog[0].payload.length).toBe(30);
  });

  it('holds a small write while earlier data is still unacknowledged', () => {
    const lab = replyingLab(7902, (peer) => { peer.send('r'); peer.send('e'); peer.send('ply'); });
    const sizes = dataSizesFrom(lab.bus, SERVER_IP);

    lab.socket.send('q');

    expect(sizes).toEqual([1, 4]);
  });

  it('TCP_NODELAY disables it, which RFC 9293 §3.7.4 makes a MUST', () => {
    const lab = replyingLab(7903, (peer) => {
      peer.setNoDelay(true);
      peer.send('r'); peer.send('e'); peer.send('ply');
    });
    const sizes = dataSizesFrom(lab.bus, SERVER_IP);

    lab.socket.send('q');

    expect(sizes).toEqual([1, 1, 3]);
  });

  it('coalesces binary payloads as bytes, not as strings', () => {
    const { client, server, bus, scheduler } = buildPair();
    let accepted: TcpSocket | null = null;
    const lengths: number[] = [];
    server.getTcpStack().listen(7904, {
      onAccept: (s) => { accepted = s; s.windowSize = 0; s.onData((d) => lengths.push((d as Uint8Array).length)); },
    });
    const socket = client.getTcpStack().connect(SERVER_IP, 7904)!;
    const sizes = dataSizesFrom(bus, CLIENT_IP);

    for (let i = 0; i < 4; i++) socket.send(new Uint8Array([i, i, i]));
    accepted!.windowSize = 64240;
    scheduler.advance(TCP_INITIAL_RTO_MS + 10);

    expect(sizes).toEqual([1, 11]);
    expect(lengths).toEqual([12]);
  });

  it('WITNESS: a bulk transfer still ships MSS-sized segments and every byte', () => {
    const { client, server, bus } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(7905, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const socket = client.getTcpStack().connect(SERVER_IP, 7905)!;
    const sizes = dataSizesFrom(bus, CLIENT_IP);

    socket.send('A'.repeat(20_000));

    expect(received.join('')).toBe('A'.repeat(20_000));
    expect(sizes.length).toBe(14);
    expect(sizes.slice(0, 13).every((n) => n === socket.mss)).toBe(true);
  });

  it('WITNESS: a receive window smaller than the MSS still completes', () => {
    const { client, server } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(7906, {
      onAccept: (s) => { s.windowSize = 128; s.onData((d) => received.push(d as string)); },
    });
    const socket = client.getTcpStack().connect(SERVER_IP, 7906)!;

    socket.send('A'.repeat(20_000));

    expect(received.join('')).toBe('A'.repeat(20_000));
    expect(socket.sendBacklog).toEqual([]);
  });

  it('WITNESS: close() leaves nothing behind the FIN', () => {
    const { client, server } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(7907, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const socket = client.getTcpStack().connect(SERVER_IP, 7907)!;
    socket.onData(() => {});

    socket.send('a');
    socket.send('held');
    socket.close();

    expect(received.join('')).toBe('aheld');
    expect(socket.sendBacklog).toEqual([]);
  });

  it('WITNESS: writes on an idle connection still leave at once', () => {
    const { client, server, bus } = buildPair();
    server.getTcpStack().listen(7908, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7908)!;
    const sizes = dataSizesFrom(bus, CLIENT_IP);

    socket.send('X'); socket.send('Y'); socket.send('Z');

    expect(sizes).toEqual([1, 1, 1]);
    expect(socket.sendUnacked).toBe(socket.sendNext);
  });
});
