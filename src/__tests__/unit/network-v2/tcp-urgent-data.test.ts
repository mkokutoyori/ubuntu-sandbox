/*
 * Le mecanisme urgent : la RFC l'EXIGE de la pile, meme si elle le
 * deconseille aux applications.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `urgentPointer` n'etait jamais emis qu'a `0` et n'etait relu nulle
 * part ; aucune API ne permettait d'emettre des donnees urgentes. Le
 * drapeau URG figurait dans la serialisation et dans le rendu tcpdump
 * (la lettre `U`), mais la LIGNE tcpdump taisait la valeur du pointeur,
 * la ou le vrai tcpdump ecrit `urg N`.
 *
 * ── L'autorite, lue et non citee de memoire ─────────────────────────
 *
 * RFC 9293 §3.8.5 tranche la question de l'opportunite, et dans les deux
 * sens a la fois : « new applications SHOULD NOT employ the TCP urgent
 * mechanism (SHLD-13). However, TCP implementations MUST still include
 * support for the urgent mechanism (MUST-30). » Deconseille a
 * l'application, EXIGE de la pile.
 *
 * Ou pointe le pointeur a fait l'objet d'une contradiction celebre.
 * RFC 9293 §3.1 : « The urgent pointer points to the sequence number of
 * the octet following the urgent data. » RFC 1122 avait voulu corriger
 * en « le DERNIER octet », mais RFC 6093 §3.2 constate que « all the
 * popular implementations […] interpret the semantics of the TCP Urgent
 * Pointer as specified in Section 3.1 of RFC 793 » et que la correction
 * « was never reflected in actual implementations ». C'est donc la
 * lecture « octet SUIVANT » qui est retenue : elle est celle de la RFC
 * en vigueur ET celle du parc.
 *
 * RFC 793 §3.7 donne l'arithmetique du recepteur : « the urgent field is
 * meaningful and must be added to the segment sequence number to yield
 * the urgent pointer ». RFC 9293 §3.8.5 donne le mode : urgent tant que
 * ce point est en avance sur RCV.NXT, normal quand RCV.NXT le rattrape.
 * RFC 6093 §3.1 dit ce que l'application recoit : « the last byte of
 * 'urgent data' is delivered 'out of band' ».
 *
 * ── CE QUI N'A PAS PU ETRE ATTEINT, ET CE QUI EN DECOULE ────────────
 *
 * Le pas « eighth, check the URG bit » du traitement SEGMENT ARRIVES n'a
 * pas pu etre lu : les deux RFC tronquent avant, depuis cet
 * environnement. La regle de mise a jour de RCV.UP n'est donc PAS citee.
 * Ce qui est applique ici est la lecture MONOTONE — un segment ne peut
 * que reculer l'echeance, jamais l'avancer — qui decoule du « whenever
 * this point is in advance of RCV.NXT » de §3.8.5, et c'est dit plutot
 * que tu.
 *
 * L'octet urgent reste AUSSI dans le flux ordinaire, ce qu'une vraie
 * socket obtient avec `SO_OOBINLINE`. Le retirer ferait diverger le
 * compte d'octets lu par l'application de celui comptable sur le fil, et
 * deux vues d'un meme transfert qui se contredisent sont le defaut que
 * ce depot refuse en premier.
 *
 * ── Discrimination (`git stash`) ────────────────────────────────────
 *
 * QUATRE cas sur six tombent : le drapeau pose sur le fil, le point
 * urgent tombant sur l'octet SUIVANT, la livraison hors bande, et la
 * ligne tcpdump.
 *
 * Les DEUX autres sont des TEMOINS et n'empruntent QUE l'API d'avant —
 * c'est la condition pour qu'ils passent des deux cotes, et un premier
 * jet l'avait manquee : ecrit avec `sendUrgent`, un temoin tombe au
 * commit parent faute d'API et ne temoigne donc de rien. Les deux
 * retenus disent qu'un transfert ORDINAIRE, court puis en vrac, ne
 * porte jamais URG et arrive entier — sans eux, une pile qui poserait
 * URG sur tout passerait les quatre premiers.
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
  return { client, server, bus };
}

interface Lab {
  socket: TcpSocket;
  accepted: () => TcpSocket;
  received: string[];
  urgent: string[];
  bus: EventBus;
}

function lab(port: number): Lab {
  const { client, server, bus } = buildPair();
  let accepted: TcpSocket | null = null;
  const received: string[] = [];
  const urgent: string[] = [];
  server.getTcpStack().listen(port, {
    onAccept: (s) => {
      accepted = s;
      s.onData((d) => received.push(d as string));
      s.onUrgent((b) => urgent.push(b));
    },
  });
  const socket = client.getTcpStack().connect(SERVER_IP, port)!;
  return { socket, accepted: () => accepted!, received, urgent, bus };
}

function clientSegments(bus: EventBus): TcpSegmentSentPayload[] {
  const seen: TcpSegmentSentPayload[] = [];
  bus.subscribe('tcp.segment.sent', (e) => {
    const p = e.payload as TcpSegmentSentPayload;
    if (p.sourceIp === CLIENT_IP) seen.push(p);
  });
  return seen;
}

describe('TCP urgent mechanism (RFC 9293 §3.8.5, MUST-30)', () => {
  it('marks URG on the wire while the urgent point is still ahead', () => {
    const l = lab(8200);
    const seen = clientSegments(l.bus);

    l.socket.sendUrgent('boom');

    const urgentSegments = seen.filter((s) => s.flagsText.includes('URG'));
    expect(urgentSegments.length).toBeGreaterThan(0);
  });

  it('lands the urgent point on the octet FOLLOWING the urgent data', () => {
    const l = lab(8201);

    l.socket.sendUrgent('boom');

    expect(l.accepted().rcvUp).toBe(l.accepted().recvNext);
    expect(l.accepted().urgentMode).toBe(false);
  });

  it('delivers the LAST urgent byte out of band (RFC 6093 §3.1)', () => {
    const l = lab(8202);

    l.socket.sendUrgent('boom');

    expect(l.urgent).toEqual(['m']);
  });

  it('tcpdump prints the urgent pointer, as the real one does', async () => {
    const { client, server, bus } = buildPair();
    let accepted: TcpSocket | null = null;
    server.getTcpStack().listen(8203, { onAccept: (s) => { accepted = s; } });
    void bus;
    const pending = client.executeCommand('tcpdump -c 20 -nn tcp and port 8203');
    await new Promise((r) => setTimeout(r, 20));
    const socket = client.getTcpStack().connect(SERVER_IP, 8203)!;
    socket.sendUrgent('boom');
    void accepted;
    await new Promise((r) => setTimeout(r, 20));
    const dump = await pending;

    expect(dump).toMatch(/urg \d+/);
  });

  it('WITNESS: an ordinary transfer carries no URG and arrives whole', () => {
    const l = lab(8204);
    const seen = clientSegments(l.bus);

    l.socket.send('plain data');

    expect(seen.some((s) => s.flagsText.includes('URG'))).toBe(false);
    expect(l.received.join('')).toBe('plain data');
  });

  it('WITNESS: a bulk ordinary transfer marks no segment urgent', () => {
    const l = lab(8205);
    const seen = clientSegments(l.bus);

    l.socket.send('A'.repeat(20_000));

    expect(l.received.join('')).toBe('A'.repeat(20_000));
    expect(seen.filter((s) => s.flagsText.includes('URG'))).toEqual([]);
  });
});
