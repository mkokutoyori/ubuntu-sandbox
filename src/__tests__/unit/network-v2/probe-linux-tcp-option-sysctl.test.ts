/**
 * Les reglages du noyau Linux qui decident ce que la pile TCP/IP propose et
 * fait existent, se lisent et s'ecrivent comme sur un noyau 5.15, et la pile
 * les evalue : tcp_sack, tcp_timestamps, tcp_window_scaling,
 * tcp_slow_start_after_idle et ip_default_ttl.
 *
 * Mesure de depart (commit precedent), un LinuxPC :
 *
 *   - `sysctl net.ipv4.<cle>` et `cat /proc/sys/net/ipv4/<cle>` repondent
 *     « cannot stat /proc/sys/net/ipv4/… » pour les cinq cles, alors que
 *     tcp_sack et ses voisines figurent dans la transcription de tout cours
 *     sur TCP ; `sysctl -a | grep tcp` ne listait que tcp_ecn,
 *     tcp_ecn_fallback et tcp_tw_reuse ;
 *   - la pile proposait TOUJOURS les quatre options dans un SYN (taille de
 *     segment, echelle de fenetre, SACK permis, horodatage) et acceptait
 *     toutes celles du pair, quoi que l'administrateur ait demande ;
 *   - le TTL de ce qu'une machine emet en IPv4 etait la constante 64, pour un
 *     SYN comme pour un datagramme UDP ;
 *   - une connexion inactive repartait toujours de la fenetre initiale
 *     (RFC 5681 §4.1), sans moyen de l'en empecher.
 *
 * Autorite : noyau 5.15, `net/ipv4/sysctl_net_ipv4.c` et
 * `Documentation/networking/ip-sysctl.rst`, lus. tcp_sack, tcp_timestamps,
 * tcp_window_scaling et tcp_slow_start_after_idle sont des octets
 * (`proc_dou8vec_minmax`, 0 a 255, defaut 1 ; toute valeur non nulle active) ;
 * ip_default_ttl est un octet de 1 a 255, defaut 64. RFC 7323 §1.3 (l'option
 * d'echelle de fenetre n'est envoyee que dans le SYN, et dans le SYN-ACK
 * seulement si le SYN en portait une) et §3.2 (meme regle pour l'horodatage,
 * qui doit ensuite figurer dans chaque segment non RST) ; RFC 2018 §4 (sans
 * SACK-permitted dans le SYN, aucun bloc SACK) ; RFC 5681 §4.1 (la fenetre de
 * redemarrage apres une inactivite plus longue que la RTO) ; la
 * documentation du noyau y renvoie par la RFC 2861.
 *
 * Ce qui est construit : `LinuxIpv4Settings`, la table des reglages d'un
 * octet (tcp_ecn et tcp_ecn_fallback y entrent, ils avaient deux champs
 * a part), lue par `/proc/sys` et ecrite par `sysctl -w` ; `TcpOptionPolicy`
 * et `restartsAfterIdle` sur `TcpHost` : le SYN ne propose que ce que
 * l'hote permet, un SYN-ACK n'accepte et une ouverture active ne retient
 * que ce qui est permis des deux cotes ; le TTL IPv4 de la machine est
 * ip_default_ttl (la limite de sauts IPv6 reste 64 : c'est un autre reglage).
 *
 * Ce qui n'est PAS construit : les valeurs 1 et 2 de tcp_timestamps, que le
 * noyau distingue par un decalage aleatoire de l'horloge par connexion (le
 * simulateur n'en a pas : les deux activent l'option) ; tcp_syn_retries,
 * tcp_retries1/2, tcp_keepalive_*, tcp_fin_timeout, tcp_congestion_control.
 *
 * Discrimination (fichier copie sur le commit precedent) : VINGT-DEUX cas
 * sur trente tombent. Les huit autres passent des deux cotes : sept
 * temoins construits dans le meme banc que le cas qu'ils gardent (le SYN
 * propose les quatre options par defaut, le duplicata d'ACK porte un bloc
 * quand SACK est permis, les segments sont de 12 octets plus courts avec
 * l'horodatage, la fenetre du premier ACK est mise a l'echelle par defaut,
 * le TTL par defaut est 64 dans un SYN comme dans une reponse d'echo, une
 * connexion inactive repart de la fenetre initiale par defaut) et une
 * non-regression (la limite de sauts IPv6 ne suit pas ip_default_ttl).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, openPassive, PEER_ISN, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import type { TcpOption, TcpSegment } from '@/network/tcp/types';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { IPAddress, type IPv4Packet } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

const MSS = 1460;
const FULL_OFFER: TcpOption[] = [
  { kind: 'mss', value: MSS }, { kind: 'window-scale', shift: 7 }, { kind: 'sack-permitted' },
  { kind: 'timestamp', tsVal: 1000, tsEcr: 0 },
];

async function write(peer: ScriptedPeer, key: string, value: number | string): Promise<string> {
  return peer.dut.executeCommand(`sudo sysctl -w net.ipv4.${key}=${value}`);
}

function kindsOf(segment: TcpSegment): string[] {
  return segment.options.map((option) => option.kind);
}

function synFromDut(peer: ScriptedPeer): TcpSegment {
  peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
  return peer.last()!;
}

function dataOf(segments: TcpSegment[]): TcpSegment[] {
  return segments.filter((s) => s.payload !== undefined && payloadBytes(s.payload).length > 0);
}

describe('the Linux TCP option knobs read and write like the kernel 5.15 (ip-sysctl.rst, sysctl_net_ipv4.c)', () => {
  it.each([
    ['tcp_sack', 1], ['tcp_timestamps', 1], ['tcp_window_scaling', 1],
    ['tcp_slow_start_after_idle', 1], ['ip_default_ttl', 64],
  ])('net.ipv4.%s reads %s by default, through sysctl and through /proc', async (key, expected) => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand(`sysctl net.ipv4.${key}`)).trim()).toBe(`net.ipv4.${key} = ${expected}`);
    expect((await peer.dut.executeCommand(`cat /proc/sys/net/ipv4/${key}`)).trim()).toBe(String(expected));
  });

  it.each(['tcp_sack', 'tcp_timestamps', 'tcp_window_scaling', 'tcp_slow_start_after_idle'])(
    'net.ipv4.%s is one byte: 0 and 255 are accepted, 256 and a negative number are not', async (key) => {
      const peer = scriptedPeer();
      expect((await write(peer, key, 0)).trim()).toBe(`net.ipv4.${key} = 0`);
      expect((await write(peer, key, 255)).trim()).toBe(`net.ipv4.${key} = 255`);
      expect(await write(peer, key, 256)).toContain('Invalid argument');
      expect(await write(peer, key, -1)).toContain('Invalid argument');
      expect((await peer.dut.executeCommand(`sysctl -n net.ipv4.${key}`)).trim()).toBe('255');
    });

  it('net.ipv4.ip_default_ttl accepts 1 to 255, nothing else', async () => {
    const peer = scriptedPeer();
    expect((await write(peer, 'ip_default_ttl', 1)).trim()).toBe('net.ipv4.ip_default_ttl = 1');
    expect((await write(peer, 'ip_default_ttl', 255)).trim()).toBe('net.ipv4.ip_default_ttl = 255');
    expect(await write(peer, 'ip_default_ttl', 0)).toContain('Invalid argument');
    expect(await write(peer, 'ip_default_ttl', 256)).toContain('Invalid argument');
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.ip_default_ttl')).trim()).toBe('255');
  });

  it('sysctl -a lists them', async () => {
    const peer = scriptedPeer();
    const listing = await peer.dut.executeCommand('sysctl -a 2>/dev/null');
    for (const key of ['tcp_sack', 'tcp_timestamps', 'tcp_window_scaling', 'tcp_slow_start_after_idle', 'ip_default_ttl']) {
      expect(listing).toContain(`net.ipv4.${key} = `);
    }
  });
});

describe('what the SYN offers follows the knobs', () => {
  it('WITNESS: by default the SYN offers the four options', () => {
    const peer = scriptedPeer();
    expect(kindsOf(synFromDut(peer))).toEqual(['mss', 'window-scale', 'sack-permitted', 'timestamp']);
  });

  it('tcp_sack=0: no SACK-permitted', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_sack', 0);
    expect(kindsOf(synFromDut(peer))).toEqual(['mss', 'window-scale', 'timestamp']);
  });

  it('tcp_timestamps=0: no timestamp', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_timestamps', 0);
    expect(kindsOf(synFromDut(peer))).toEqual(['mss', 'window-scale', 'sack-permitted']);
  });

  it('tcp_window_scaling=0: no window scale', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_window_scaling', 0);
    expect(kindsOf(synFromDut(peer))).toEqual(['mss', 'sack-permitted', 'timestamp']);
  });

  it('all three off: the SYN carries the maximum segment size alone', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_sack', 0);
    await write(peer, 'tcp_timestamps', 0);
    await write(peer, 'tcp_window_scaling', 0);
    expect(kindsOf(synFromDut(peer))).toEqual(['mss']);
  });
});

describe('what is negotiated needs both ends: an option the host has switched off is ignored when the peer offers it', () => {
  it('tcp_sack=0 on a listener: the SYN-ACK does not accept SACK and the duplicate ACKs carry no block', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_sack', 0);
    const connection = openPassive(peer, FULL_OFFER);
    expect(connection.socket.sackEnabled).toBe(false);
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1 + MSS, acknowledgement: connection.dutIsn + 1,
      payload: 'x'.repeat(100), window: 65535,
    });
    const answer = peer.last()!;
    expect(answer.options.some((option) => option.kind === 'sack')).toBe(false);
  });

  it('WITNESS: tcp_sack=1 on the same listener: the duplicate ACK carries a block', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, FULL_OFFER);
    expect(connection.socket.sackEnabled).toBe(true);
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1 + MSS, acknowledgement: connection.dutIsn + 1,
      payload: 'x'.repeat(100), window: 65535,
    });
    expect(peer.last()!.options.some((option) => option.kind === 'sack')).toBe(true);
  });

  it('tcp_timestamps=0 on an active open: a timestamp in the SYN-ACK is ignored, data segments carry none and are one MSS long', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_timestamps', 0);
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }, { kind: 'timestamp', tsVal: 5, tsEcr: 0 }]);
    expect(connection.socket.timestampsEnabled).toBe(false);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(3 * MSS));
    const sent = dataOf(peer.take());
    expect(sent.map((s) => payloadBytes(s.payload).length)).toEqual([MSS, MSS, MSS]);
    expect(sent.some((s) => s.options.some((option) => option.kind === 'timestamp'))).toBe(false);
  });

  it('WITNESS: by default the same SYN-ACK negotiates timestamps and the segments are 12 bytes shorter', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }, { kind: 'timestamp', tsVal: 5, tsEcr: 0 }]);
    expect(connection.socket.timestampsEnabled).toBe(true);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(3 * MSS));
    expect(dataOf(peer.take()).map((s) => payloadBytes(s.payload).length)[0]).toBe(MSS - 12);
  });

  function handshakeAck(peer: ScriptedPeer): { ack: TcpSegment; socket: TcpSocket } {
    const socket = peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.send({
      flags: 'SA', sequence: PEER_ISN, acknowledgement: syn.sequence + 1, window: 65535,
      options: [{ kind: 'mss', value: MSS }, { kind: 'window-scale', shift: 7 }],
    });
    return { ack: peer.last()!, socket };
  }

  it('tcp_window_scaling=0: a window scale in the SYN-ACK is ignored and the window field is not scaled', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_window_scaling', 0);
    const { ack, socket } = handshakeAck(peer);
    expect(socket.peerWindowScale).toBeNull();
    expect(ack.window).toBe(65535);
  });

  it('WITNESS: by default the window field of the same exchange is scaled by 128', () => {
    const peer = scriptedPeer();
    const { ack, socket } = handshakeAck(peer);
    expect(socket.peerWindowScale).toBe(7);
    expect(ack.window).toBe(65535 >> 7);
  });
});

describe('net.ipv4.ip_default_ttl is the TTL of what the host originates over IPv4', () => {
  function ttlOfLast(peer: ScriptedPeer): number {
    return (peer.frames[peer.frames.length - 1].payload as IPv4Packet).ttl;
  }

  it('the SYN carries it', async () => {
    const peer = scriptedPeer();
    await write(peer, 'ip_default_ttl', 37);
    synFromDut(peer);
    expect(ttlOfLast(peer)).toBe(37);
  });

  it('WITNESS: the default is 64', () => {
    const peer = scriptedPeer();
    synFromDut(peer);
    expect(ttlOfLast(peer)).toBe(64);
  });

  it('a UDP datagram carries it', async () => {
    const peer = scriptedPeer();
    await write(peer, 'ip_default_ttl', 21);
    peer.dut.sendUdpDatagram(new IPAddress(peer.addresses.peer), 9, 9, 'hello');
    expect(ttlOfLast(peer)).toBe(21);
  });

  async function ttlSeenByPinger(responderTtl: number | null): Promise<string | undefined> {
    const pc = new LinuxPC('PC1', 0, 0);
    const responder = new LinuxServer('linux-server', 'SRV', 100, 0);
    new Cable('c1').connect(pc.getPort('eth0')!, responder.getPort('eth0')!);
    await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await responder.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    if (responderTtl !== null) await responder.executeCommand(`sudo sysctl -w net.ipv4.ip_default_ttl=${responderTtl}`);
    return (await pc.executeCommand('ping -c 1 10.0.0.2')).match(/ttl=(\d+)/)?.[1];
  }

  it('an echo reply carries it: the machine that pings reads it in the reply', async () => {
    expect(await ttlSeenByPinger(37)).toBe('37');
  });

  it('WITNESS: the same exchange with the default shows 64', async () => {
    expect(await ttlSeenByPinger(null)).toBe('64');
  });

  it('the IPv6 hop limit is not that knob: a SYN over IPv6 keeps 64', async () => {
    const peer = scriptedPeer('linux', 'ipv6');
    await write(peer, 'ip_default_ttl', 5);
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    const frame = peer.frames[peer.frames.length - 1].payload as { hopLimit: number };
    expect(frame.hopLimit).toBe(64);
  });
});

describe('net.ipv4.tcp_slow_start_after_idle decides whether an idle connection starts again at the initial window (RFC 5681 §4.1)', () => {
  function burstAfterIdle(peer: ScriptedPeer): number {
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    connection.socket.setNoDelay(true);
    connection.socket.cc.cwnd = 20 * MSS;
    connection.socket.write('a'.repeat(4 * MSS));
    const first = dataOf(peer.take());
    const last = first[first.length - 1];
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1, acknowledgement: (last.sequence + payloadBytes(last.payload).length) >>> 0,
      window: 65535,
    });
    peer.clear();
    peer.advance(10_000);
    connection.socket.write('a'.repeat(20 * MSS));
    return dataOf(peer.take()).length;
  }

  it('by default the connection restarts: the burst after the idle period is the initial window', () => {
    expect(burstAfterIdle(scriptedPeer())).toBe(3);
  });

  it('tcp_slow_start_after_idle=0: the connection keeps the window it had', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_slow_start_after_idle', 0);
    expect(burstAfterIdle(peer)).toBe(20);
  });
});
