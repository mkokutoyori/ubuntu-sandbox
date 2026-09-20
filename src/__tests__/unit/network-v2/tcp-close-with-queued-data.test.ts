/*
 * `close()` ne doit pas emettre le FIN DEVANT des octets jamais envoyes.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Une socket ecrit 25 octets alors que le pair annonce une fenetre de
 * ZERO, puis appelle `close()`. La trace cliente etait
 *
 *     ACK|FIN len=0 seq=+0
 *     ACK    len=0 seq=+1
 *
 * Le FIN partait au PREMIER numero de sequence, devant des donnees
 * restees dans `sendBacklog` ; le recepteur ne recevait RIEN, la
 * connexion passait en `time-wait` comme si tout avait ete livre, et la
 * file gardait son entree pour personne. Une perte silencieuse, sans
 * erreur rendue a l'appelant — le pire des trois, puisque rien ne la
 * signale.
 *
 * ── L'autorite ──────────────────────────────────────────────────────
 *
 * RFC 9293 §3.10.4, CLOSE Call : « Queue this request until all
 * preceding SENDs have been segmentized; then send a FIN segment ». Le
 * FIN consomme un numero de sequence et se place APRES le dernier octet
 * de donnees ; l'emettre avant, c'est decrire un flux qui n'a pas eu
 * lieu.
 *
 * ── La reparation, et pourquoi elle reutilise l'existant ────────────
 *
 * `closeAfterFlush` existait deja pour `syn-received` — une `close()`
 * appelee depuis `onAccept`, avant que la poignee de main soit finie.
 * C'est exactement la meme question posee a un autre moment : « ferme,
 * mais pas avant que ce qui attend soit parti ». L'indicateur est donc
 * ETENDU a `established`/`close-wait` plutot que double, et la fin de
 * `flushSendBacklog` le consulte quand la file se vide.
 *
 * Le minuteur de persistance reste arme pendant l'attente, donc la
 * reouverture de la fenetre finit par arriver et le FIN part derriere
 * ses donnees.
 *
 * ── Discrimination (`git stash` de `TcpStack.ts`) ───────────────────
 *
 * DEUX cas sur quatre tombent : la livraison des octets en attente, et
 * l'ordre FIN/donnees sur le fil.
 *
 * Les DEUX autres sont des TEMOINS et passent des deux cotes : la
 * fermeture sur fenetre OUVERTE, qui doit rester immediate — sans lui,
 * une pile qui ne fermerait plus jamais passerait les deux premiers —
 * et la fermeture sans rien en attente, qui est le cas courant.
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

interface ClientSegment { flags: string; payloadSize: number; sequence: number }

function clientSegments(bus: EventBus): ClientSegment[] {
  const seen: ClientSegment[] = [];
  bus.subscribe('tcp.segment.sent', (e) => {
    const p = e.payload as TcpSegmentSentPayload;
    if (p.sourceIp === CLIENT_IP) {
      seen.push({ flags: p.flagsText, payloadSize: p.payloadSize, sequence: p.sequence >>> 0 });
    }
  });
  return seen;
}

function closedWindowLab(port: number) {
  const lab = buildPair();
  let accepted: TcpSocket | null = null;
  const received: string[] = [];
  lab.server.getTcpStack().listen(port, {
    onAccept: (s) => { accepted = s; s.windowSize = 0; s.onData((d) => received.push(d as string)); },
  });
  const socket = lab.client.getTcpStack().connect(SERVER_IP, port)!;
  return { ...lab, socket, received, reopen: () => { accepted!.windowSize = 64240; } };
}

describe('TCP close() with data still queued (RFC 9293 §3.10.4)', () => {
  it('delivers data the closed window was holding instead of dropping it', () => {
    const lab = closedWindowLab(8100);

    lab.socket.send('payload-that-cannot-leave');
    lab.socket.close();
    lab.reopen();
    lab.scheduler.advance(TCP_INITIAL_RTO_MS * 4);

    expect(lab.received.join('')).toBe('payload-that-cannot-leave');
  });

  it('puts the FIN behind its own data on the wire, never in front', () => {
    const lab = closedWindowLab(8101);
    const seen = clientSegments(lab.bus);

    lab.socket.send('payload-that-cannot-leave');
    lab.socket.close();
    lab.reopen();
    lab.scheduler.advance(TCP_INITIAL_RTO_MS * 4);

    const fin = seen.find((s) => s.flags.includes('FIN'));
    expect(fin).toBeDefined();
    const dataBefore = seen.filter((s) => s.payloadSize > 0 && s.sequence < fin!.sequence);
    const carried = dataBefore.reduce((n, s) => n + s.payloadSize, 0);
    expect(carried).toBe('payload-that-cannot-leave'.length);
  });

  it('WITNESS: a close over an OPEN window is still immediate', () => {
    const { client, server, bus } = buildPair();
    const received: string[] = [];
    server.getTcpStack().listen(8102, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const socket = client.getTcpStack().connect(SERVER_IP, 8102)!;
    const seen = clientSegments(bus);

    socket.send('leaves at once');
    socket.close();

    expect(received.join('')).toBe('leaves at once');
    expect(seen.some((s) => s.flags.includes('FIN'))).toBe(true);
    expect(socket.sendBacklog).toEqual([]);
  });

  it('WITNESS: a close with nothing queued still closes', () => {
    const { client, server, bus } = buildPair();
    server.getTcpStack().listen(8103, { onAccept: () => {} });
    const socket = client.getTcpStack().connect(SERVER_IP, 8103)!;
    const seen = clientSegments(bus);

    socket.close();

    expect(seen.some((s) => s.flags.includes('FIN'))).toBe(true);
  });
});
