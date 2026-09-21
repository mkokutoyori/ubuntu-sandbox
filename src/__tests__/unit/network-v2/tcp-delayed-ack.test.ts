/*
 * L'ACK retarde : un ACK pour deux segments pleins (RFC 5681 §4.2).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `_processSegment` repondait a CHAQUE segment porteur de donnees par un
 * ACK pur immediat. Sur un transfert de 20000 octets la mesure comptait
 * 14 ACK purs pour 14 segments — un pour un. Une pile reelle en emet la
 * moitie, et ce n'est pas qu'une economie de trafic : c'est la cadence
 * que le comptage des ACK DUPLIQUES suppose, donc une trace prise ici ne
 * ressemblait pas a ce qu'un apprenant lit dans son propre tcpdump.
 *
 * ── L'autorite ──────────────────────────────────────────────────────
 *
 * RFC 5681 §4.2 : « an ACK SHOULD be generated for at least every second
 * full-sized segment, and MUST be generated within 500 ms of the arrival
 * of the first unacknowledged packet », et « out-of-order data segments
 * SHOULD be acknowledged immediately ». Les deux moities comptent : la
 * seconde est ce qui garde le fast retransmit atteignable.
 *
 * ── L'horloge, ici, est la FIN DE RAFALE ────────────────────────────
 *
 * La livraison des trames est synchrone dans ce simulateur (CLAUDE.md,
 * « Known limits »), donc un `setTimeout` de 200 ms ne peut pas rendre
 * la main au milieu d'un `send()` : un ACK retarde pose sur ce seul
 * temporisateur bloque le flux au lieu de le fluidifier — mesure faite,
 * une fenetre de 1280 octets ne livrait plus rien. Ce qui joue le role
 * de l'horloge est donc le moment ou la rafale se termine : quand
 * `_sendData` (ou une sonde de persistance, ou un RTO) a fini de
 * derouler, le pair a DEJA traite tous les segments, et c'est
 * exactement l'instant ou l'ACK est du. Le temporisateur reste arme
 * comme garde-fou pour les donnees qui arrivent HORS de toute rafale —
 * un segment injecte sur le port, par exemple — et le troisieme cas
 * ci-dessous est la pour le prouver plutot que de le supposer.
 *
 * Le drain ne porte PAS de limite de tours : elle etait d'abord fixee a
 * 64, et la mesure l'a prise en faute — avec une fenetre annoncee de 128
 * octets il faut 157 tours, et le transfert s'arretait a 0 octet livre
 * sur 20000. Le drain se termine de lui-meme parce que seul un segment
 * PORTEUR DE DONNEES peut redevoir un ACK, qu'un ACK pur n'en porte
 * jamais, et que les donnees sont finies.
 *
 * ── Discrimination (`git stash` de `TcpStack.ts`) ───────────────────
 *
 * TROIS cas sur huit tombent : les deux comptages d'ACK (mesures 3 et
 * 14 avant, 2 et 8 apres) et le garde-fou a 200 ms, qui avant repondait
 * immediatement au segment injecte.
 *
 * Le second comptage vaut 8 et non 7 depuis que Nagle existe, et le
 * chiffre est juste : les 13 segments pleins se font acquitter deux par
 * deux, le 13e laisse un ACK du que le drain libere, et Nagle RETIENT le
 * 14e — 1020 octets, moins d'un segment plein — jusqu'a cet acquittement,
 * si bien que ce dernier morceau paie son propre ACK. C'est l'aller-retour
 * de queue bien connu de Nagle sous ACK retarde, et la RFC 9293 §3.7.4 le
 * veut ainsi : elle fait tamponner « all user data (regardless of the PSH
 * bit) ». Le trafic reste divise par pres de deux ; il n'est simplement
 * pas divise par exactement deux.
 *
 * Les CINQ autres sont des TEMOINS et passent des deux cotes :
 *   - l'integralite des octets, qui prouve que le laboratoire tient —
 *     sans lui, une pile qui n'acquitterait plus rien du tout passerait
 *     les deux comptages ;
 *   - le fait que rien ne reste du au retour de `send()`, contrat du
 *     drain, trivialement vrai avant puisque tout etait acquitte ;
 *   - l'ACK immediat sur donnees hors sequence, structurel : c'est lui
 *     qui garde les ACK dupliques comptables. Sa perte vise le PREMIER
 *     segment de donnees, seul rang qui designe la meme trame des deux
 *     cotes : viser le second aurait touche un segment de donnees apres
 *     le changement et un ACK pur avant, donc n'aurait rien temoigne du
 *     tout. Mesure : 3 ACK identiques des deux cotes, soit le seuil de
 *     la RFC 5681 §3.2 ;
 *   - le segment qui COMBLE un trou, acquitte avant que la moindre autre
 *     donnee ne reparte (RFC 5681 §4.2, « an immediate ACK … when the
 *     incoming segment fills in all or part of a gap »). Trivial avant
 *     puisque tout etait acquitte ; l'ACK retarde le cassait, et la
 *     mesure le montre sur la trace — sans la regle, l'ACK qui depasse
 *     le doublon n'arrive qu'apres le segment SUIVANT, et il couvre
 *     alors +5840 au lieu de +4381 ;
 *   - une fenetre plus petite que le MSS, non-regression : c'est le cas
 *     que l'ACK retarde naif bloquait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask,
  createIPv4Packet, ETHERTYPE_IPV4, IP_PROTO_TCP,
} from '@/network/core/types';
import { computeTcpChecksum, type TcpSegment } from '@/network/tcp/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TCP_DELAYED_ACK_MS } from '@/network/tcp/TcpStack';
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
  return { client, server, bus, cable, scheduler };
}

function pureAcksFrom(bus: EventBus, sourceIp: string): number[] {
  const acknowledgements: number[] = [];
  bus.subscribe('tcp.segment.sent', (e) => {
    const p = e.payload as TcpSegmentSentPayload;
    if (p.sourceIp === sourceIp && p.payloadSize === 0 && p.flagsText === 'ACK') {
      acknowledgements.push(p.acknowledgement);
    }
  });
  return acknowledgements;
}

interface WireEvent { fromClient: boolean; payloadSize: number; acknowledgement: number }

function wireTrace(bus: EventBus): WireEvent[] {
  const events: WireEvent[] = [];
  bus.subscribe('tcp.segment.sent', (e) => {
    const p = e.payload as TcpSegmentSentPayload;
    events.push({
      fromClient: p.sourceIp === CLIENT_IP,
      payloadSize: p.payloadSize,
      acknowledgement: p.acknowledgement >>> 0,
    });
  });
  return events;
}

function injectDataFromServer(
  client: LinuxPC, server: LinuxServer, socket: TcpSocket, payload: string,
): void {
  const seg = {
    type: 'tcp', sourcePort: socket.remotePort, destinationPort: socket.localPort,
    sequence: socket.recvNext, acknowledgement: socket.sendNext, dataOffset: 5,
    flags: { fin: false, syn: false, rst: false, psh: true, ack: true, urg: false },
    window: 64240, checksum: 0, urgentPointer: 0, options: [], payload,
  } as unknown as TcpSegment;
  seg.checksum = computeTcpChecksum(seg, SERVER_IP, CLIENT_IP);
  client.getPort('eth0')!.receiveFrame({
    srcMAC: server.getPort('eth0')!.getMAC(), dstMAC: client.getPort('eth0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress(SERVER_IP), new IPAddress(CLIENT_IP), IP_PROTO_TCP, 64, seg, 20),
  } as never);
}

describe('TCP delayed ACK (RFC 5681 §4.2)', () => {
  it('acknowledges one segment in two, not one in one', () => {
    const { client, server, bus } = buildPair();
    server.getTcpStack().listen(7600, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7600)!;
    const acks = pureAcksFrom(bus, SERVER_IP);

    socket.send('A'.repeat(3 * socket.mss));

    expect(acks.length).toBe(2);
  });

  it('cuts the pure-ACK count of a bulk transfer nearly in half', () => {
    const { client, server, bus } = buildPair();
    server.getTcpStack().listen(7601, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7601)!;
    const acks = pureAcksFrom(bus, SERVER_IP);

    socket.send('A'.repeat(20_000));

    expect(acks.length).toBe(8);
  });

  it('releases an ACK owed outside any send burst through the 200 ms timer', () => {
    const { client, server, bus, scheduler } = buildPair();
    server.getTcpStack().listen(7602, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7602)!;
    const acks = pureAcksFrom(bus, CLIENT_IP);

    injectDataFromServer(client, server, socket, 'ping outside any burst');

    expect(acks).toEqual([]);
    expect(socket.delayedAckTimer).not.toBeNull();

    scheduler.advance(TCP_DELAYED_ACK_MS + 1);

    expect(acks.length).toBe(1);
    expect(acks[0]).toBe(socket.recvNext);
    expect(socket.delayedAckTimer).toBeNull();
  });

  it('WITNESS: every byte still arrives, in order and intact', () => {
    const { client, server } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(7603, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const socket = client.getTcpStack().connect(SERVER_IP, 7603)!;

    socket.send('A'.repeat(20_000));

    expect(received.join('')).toBe('A'.repeat(20_000));
  });

  it('WITNESS: nothing stays owed once send() returns', () => {
    const { client, server, bus } = buildPair();
    server.getTcpStack().listen(7604, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7604)!;
    const acks = pureAcksFrom(bus, SERVER_IP);

    socket.send('A'.repeat(20_000));

    expect(acks[acks.length - 1]).toBe(socket.sendNext);
  });

  it('WITNESS: out-of-order data is acknowledged immediately', () => {
    const { client, server, bus, cable } = buildPair();
    server.getTcpStack().listen(7605, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7605)!;
    const acks = pureAcksFrom(bus, SERVER_IP);

    let transmits = 0;
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++transmits === 1 ? 0 : 1));
    socket.send('A'.repeat(12_000));

    const repeated = acks.filter((a) => a === acks[0]).length;
    expect(repeated).toBeGreaterThanOrEqual(3);
  });

  it('WITNESS: a segment that fills a gap is acknowledged before any further data goes out', () => {
    const { client, server, bus, cable } = buildPair();
    server.getTcpStack().listen(7607, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 7607)!;
    const wire = wireTrace(bus);

    let transmits = 0;
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++transmits === 1 ? 0 : 1));
    socket.send('A'.repeat(12_000));

    const serverAcks = wire.filter((e) => !e.fromClient && e.payloadSize === 0);
    const duplicated = serverAcks[0].acknowledgement;
    const advanceIndex = wire.findIndex(
      (e) => !e.fromClient && e.payloadSize === 0 && e.acknowledgement !== duplicated,
    );
    expect(advanceIndex).toBeGreaterThan(0);

    let lastDuplicate = -1;
    for (let i = 0; i < advanceIndex; i++) {
      if (!wire[i].fromClient && wire[i].acknowledgement === duplicated) lastDuplicate = i;
    }
    const sinceLastDuplicate = wire
      .slice(lastDuplicate + 1, advanceIndex)
      .filter((e) => e.fromClient && e.payloadSize > 0);
    expect(sinceLastDuplicate.length).toBe(1);
  });

  it('WITNESS: a receive window smaller than the MSS still completes inside send()', () => {
    const { client, server } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(7606, {
      onAccept: (s) => { s.windowSize = 128; s.onData((d) => received.push(d as string)); },
    });
    const socket = client.getTcpStack().connect(SERVER_IP, 7606)!;

    socket.send('A'.repeat(20_000));

    expect(received.join('')).toBe('A'.repeat(20_000));
  });
});
