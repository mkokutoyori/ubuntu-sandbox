/**
 * `nc -M`, `-m`, `-T` et `-N` agissent sur la prise, comme le `nc` d'OpenBSD
 * (celui de Debian et d'Ubuntu, `netcat-openbsd`).
 *
 * Mesure de depart (commit precedent), pair SCRIPTE qui lit chaque en-tete IP :
 *
 *   - `-M`, `-m` et `-T` etaient refuses (« this simulator cannot build an
 *     outgoing TTL on its socket »), alors que la pile savait deja poser un TTL
 *     et un champ DiffServ par connexion ;
 *   - `-N` etait accepte et ignore : un serveur qui ne repond qu'apres la fin
 *     de fichier — celui pour lequel l'option existe — ne repondait jamais ;
 *   - aucune prise ne savait jeter un paquet dont le TTL est trop bas : le
 *     TTL minimal (IP_MINTTL, IPV6_MINHOPCOUNT, la garde GTSM de la RFC 5082)
 *     n'existait nulle part ;
 *   - deux tables de mots-cles DSCP (`ACLEngine.DSCP_KEYWORD_TO_VALUE` et
 *     `DscpTunnelMarker.DSCP`) disaient les memes faits, et `nc` en aurait
 *     ecrit une troisieme.
 *
 * Autorite : le source de `netcat.c` d'OpenBSD, lu (raw.githubusercontent.com) —
 * `-M` et `-m` : `strtonum(optarg, 0, 255)`, « ttl is invalid / too small / too
 * large » ; `-T` : TLS d'abord, puis les mots-cles (DSCP af11 a af43, cs0 a cs7,
 * ef, va, et critical, inetcontrol, lowdelay, netcontrol, reliability,
 * throughput), puis un nombre en hexadecimal `0x..` ou decimal de 0 a 255, sinon
 * « illegal tos/tls value » ; `set_common_sockopts` pose IP_TOS ou IPV6_TCLASS,
 * IP_TTL ou IPV6_UNICAST_HOPS, IP_MINTTL ou IPV6_MINHOPCOUNT sur chaque prise ;
 * `-N` appelle `shutdown(SHUT_WR)` a la fin de l'entree. Le noyau Linux, lu :
 * `do_ip_setsockopt` refuse IP_TTL 0 (EINVAL, d'ou « set IP TTL: Invalid
 * argument ») alors qu'IPV6_UNICAST_HOPS accepte 0 ; `tcp_v4_rcv` et
 * `tcp_v6_rcv` jettent un segment dont le TTL est sous `min_ttl` a l'etiquette
 * `process:`, donc apres le traitement de TIME-WAIT, sans RST, ecoute comprise ;
 * `tcp_v4_err` et `tcp_v6_err` appliquent le meme seuil au TTL cite par une
 * erreur ICMP ; aucun code d'UDP ne lit `min_ttl` (l'option est acceptee sans
 * effet sur une prise UDP). RFC 5082 §2 (GTSM).
 *
 * Ce qui est construit : `HopLimit` (0 a 255, le champ IPv6) et `TtlFloor` (0 a
 * 255) comme types ; le TTL minimal sur la prise, l'ecoute et la prise acceptee
 * (heritage), evalue a chaque segment recu et a chaque erreur ICMP ; `-N` =
 * fin d'emission pendant que la lecture continue ; une seule table de mots-cles
 * DSCP (`core/IpHeaderFields`) dont `ACLEngine` et `DscpTunnelMarker` derivent.
 *
 * Discrimination (fichier copie sur le commit precedent, avec une coquille
 * pour `TtlFloor`, absent de la base) : TRENTE cas sur trente-six tombent. Les
 * SIX autres passent des deux cotes : les TEMOINS (les valeurs par defaut
 * sortent sans option ; les adresses du laboratoire), la sortie de TIME-WAIT
 * (cas STRUCTUREL : la base n'a aucun seuil, donc n'en jette rien), deux
 * NON-REGRESSIONS (« sans -N le meme serveur ne repond jamais », « -N ne change
 * rien pour un serveur qui repond tout de suite » : la base n'envoyait pas la
 * fin d'emission, elle ne la changeait donc pas) et l'accord des tables DSCP
 * (deux tables qui concordaient deja).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, DUT_ADDRESS, PEER_ADDRESS, DUT_ADDRESS_V6, PEER_ADDRESS_V6, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import {
  ETHERTYPE_IPV4, ETHERTYPE_IPV6, IP_PROTO_TCP, IP_PROTO_UDP, IPv6Address, IPAddress, SubnetMask, MACAddress,
  resetCounters, type IPv4Packet, type IPv6Packet,
} from '@/network/core/types';
import { TtlFloor } from '@/network/core/IpHeaderFields';
import { DSCP_KEYWORD_TO_VALUE } from '@/network/devices/router/ACLEngine';
import { DSCP } from '@/network/ipsec/DscpTunnelMarker';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface OnWire { ttl: number; tos: number; protocol: number }

const NC_PORT = 4000;

function addressedToNc(payload: unknown): boolean {
  return (payload as { destinationPort?: number }).destinationPort === NC_PORT;
}

function onWire(peer: ScriptedPeer, protocol: number): OnWire[] {
  return peer.frames.flatMap((frame) => {
    if (frame.etherType === ETHERTYPE_IPV4) {
      const packet = frame.payload as IPv4Packet;
      return packet.protocol === protocol && addressedToNc(packet.payload)
        ? [{ ttl: packet.ttl, tos: packet.tos, protocol }] : [];
    }
    if (frame.etherType === ETHERTYPE_IPV6) {
      const packet = frame.payload as IPv6Packet;
      return packet.nextHeader === protocol && addressedToNc(packet.payload)
        ? [{ ttl: packet.hopLimit, tos: packet.trafficClass, protocol }] : [];
    }
    return [];
  });
}

function refusing(peer: ScriptedPeer): void {
  peer.respond((segment) => {
    if (!segment.flags.syn || segment.flags.ack) return;
    peer.ports.dut = segment.sourcePort;
    peer.send({
      flags: 'RA', sequence: 0, acknowledgement: segment.sequence + 1, sourcePort: segment.destinationPort,
    });
  });
}

async function nc(peer: ScriptedPeer, command: string): Promise<string> {
  return peer.dut.executeCommand(command);
}

describe('nc -M, -T : the datagrams and segments leave with what was asked', () => {
  it.each([
    ['-M 5', 5, 0],
    ['-T af11', 64, 0x28],
    ['-T ef', 64, 0xb8],
    ['-T va', 64, 0xb0],
    ['-T lowdelay', 64, 0x10],
    ['-T critical', 64, 0xa0],
    ['-T 0x10', 64, 0x10],
    ['-T 184', 64, 184],
    ['-M 9 -T cs6', 9, 0xc0],
  ])('TCP over IPv4: %s', async (options, ttl, tos) => {
    const peer = scriptedPeer();
    refusing(peer);
    await nc(peer, `nc ${options} -w 0 ${PEER_ADDRESS} 4000`);
    expect(onWire(peer, IP_PROTO_TCP)[0]).toEqual({ ttl, tos, protocol: IP_PROTO_TCP });
  });

  it('TCP over IPv6 uses the hop limit and the traffic class', async () => {
    const peer = scriptedPeer('linux', 'ipv6');
    refusing(peer);
    await nc(peer, `nc -6 -M 7 -T ef -w 0 ${PEER_ADDRESS_V6} 4000`);
    expect(onWire(peer, IP_PROTO_TCP)[0]).toEqual({ ttl: 7, tos: 0xb8, protocol: IP_PROTO_TCP });
  });

  it('a hop limit of 0 is accepted over IPv6 and leaves as 0', async () => {
    const peer = scriptedPeer('linux', 'ipv6');
    refusing(peer);
    await nc(peer, `nc -6 -M 0 -w 0 ${PEER_ADDRESS_V6} 4000`);
    expect(onWire(peer, IP_PROTO_TCP)[0].ttl).toBe(0);
  });

  it('UDP over IPv4 carries both', async () => {
    const peer = scriptedPeer();
    await nc(peer, `echo hi | nc -u -M 9 -T cs6 ${PEER_ADDRESS} 4000`);
    expect(onWire(peer, IP_PROTO_UDP)).toEqual([{ ttl: 9, tos: 0xc0, protocol: IP_PROTO_UDP }]);
  });

  it('UDP over IPv6 carries both', async () => {
    const peer = scriptedPeer('linux', 'ipv6');
    await nc(peer, `echo hi | nc -u -6 -M 9 -T cs6 ${PEER_ADDRESS_V6} 4000`);
    expect(onWire(peer, IP_PROTO_UDP)).toEqual([{ ttl: 9, tos: 0xc0, protocol: IP_PROTO_UDP }]);
  });

  it('WITNESS: without options the defaults go out', async () => {
    const peer = scriptedPeer();
    refusing(peer);
    await nc(peer, `nc -w 0 ${PEER_ADDRESS} 4000`);
    expect(onWire(peer, IP_PROTO_TCP)[0]).toEqual({ ttl: 64, tos: 0, protocol: IP_PROTO_TCP });
  });
});

describe('nc refuses a value the way netcat.c and the kernel refuse it', () => {
  it.each([
    ['-M 256', 'nc: ttl is too large'],
    ['-M -1', 'nc: ttl is too small'],
    ['-M x', 'nc: ttl is invalid'],
    ['-m 256', 'nc: minttl is too large'],
    ['-m x', 'nc: minttl is invalid'],
    ['-T 300', 'nc: illegal tos/tls value 300'],
    ['-T default', 'nc: illegal tos/tls value default'],
    ['-T zorglub', 'nc: illegal tos/tls value zorglub'],
    ['-M 0', 'nc: set IP TTL: Invalid argument'],
  ])('%s', async (options, message) => {
    const peer = scriptedPeer();
    expect((await nc(peer, `nc ${options} -w 0 ${PEER_ADDRESS} 4000`)).trim()).toBe(message);
  });

  it('a TLS keyword given to -T is a TLS request, and TLS is not built here', async () => {
    const peer = scriptedPeer();
    expect(await nc(peer, `nc -T noverify -w 0 ${PEER_ADDRESS} 4000`)).toMatch(/cannot build TLS/);
  });

  it('a hexadecimal prefix with no digit reads as 0, as strtol does', async () => {
    const peer = scriptedPeer();
    refusing(peer);
    await nc(peer, `nc -T 0xzz -w 0 ${PEER_ADDRESS} 4000`);
    expect(onWire(peer, IP_PROTO_TCP)[0].tos).toBe(0);
  });
});

describe('the minimum incoming TTL (IP_MINTTL, IPV6_MINHOPCOUNT, RFC 5082)', () => {
  function drops(peer: ScriptedPeer): string[] {
    const reasons: string[] = [];
    peer.bus.subscribe('tcp.segment.dropped', (event) => reasons.push(event.payload.reason));
    return reasons;
  }

  it('a listener drops a SYN whose TTL is below the floor, without a reset', () => {
    const peer = scriptedPeer();
    const reasons = drops(peer);
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined, ttlFloor: TtlFloor.of(200) });
    peer.send({ flags: 'S', sequence: 100, ttl: 199 });
    expect(peer.replies).toEqual([]);
    expect(reasons).toEqual(['ttl-below-floor']);
    peer.send({ flags: 'S', sequence: 100, ttl: 200 });
    expect(peer.replies.map((segment) => segment.flags.syn && segment.flags.ack)).toEqual([true]);
  });

  it('nc -l -m installs that floor, and the connection it accepts inherits it', async () => {
    const peer = scriptedPeer();
    expect(await nc(peer, `nc -l -m 200 ${peer.ports.dut}`)).toBe('');
    peer.send({ flags: 'S', sequence: 100, ttl: 64 });
    expect(peer.replies).toEqual([]);
    peer.send({ flags: 'S', sequence: 100, ttl: 255 });
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: 101, acknowledgement: synAck.sequence + 1, ttl: 255 });
    const reasons = drops(peer);
    peer.send({ flags: 'PA', sequence: 101, acknowledgement: synAck.sequence + 1, payload: 'x', ttl: 10 });
    expect(reasons).toEqual(['ttl-below-floor']);
  });

  it('an established connection drops a low-TTL segment, and nc -m on a connect starts the same', async () => {
    const peer = scriptedPeer();
    let replyTtl = 64;
    peer.respond((segment) => {
      if (!segment.flags.syn || segment.flags.ack) return;
      peer.ports.dut = segment.sourcePort;
      peer.send({
        flags: 'SA', sequence: 9000, acknowledgement: segment.sequence + 1,
        sourcePort: segment.destinationPort, ttl: replyTtl,
      });
    });
    await nc(peer, `nc -m 255 -w 0 ${PEER_ADDRESS} 4000`);
    expect(peer.dut.getTcpStack().connectOutcome(PEER_ADDRESS, 4000)).toBe('open');
    replyTtl = 255;
    const out = await nc(peer, `nc -m 255 -v -w 0 ${PEER_ADDRESS} 4000`);
    expect(out).toMatch(/succeeded!/);
  });

  it('TIME-WAIT is not subject to the floor', () => {
    const peer = scriptedPeer();
    const accepted: { socket: import('@/network/tcp/TcpStack').TcpSocket | null } = { socket: null };
    peer.dut.getTcpStack().listen(peer.ports.dut, {
      onAccept: (socket) => { accepted.socket = socket; }, ttlFloor: TtlFloor.of(50),
    });
    peer.send({ flags: 'S', sequence: 100, ttl: 64 });
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: 101, acknowledgement: synAck.sequence + 1, ttl: 64 });
    accepted.socket!.close();
    peer.send({ flags: 'FA', sequence: 101, acknowledgement: peer.last()!.sequence + 1, ttl: 64 });
    expect(accepted.socket!.state).toBe('time-wait');
    const reasons = drops(peer);
    peer.send({ flags: 'FA', sequence: 101, acknowledgement: peer.last()!.sequence + 1, ttl: 1 });
    expect(reasons).toEqual([]);
  });

  it('an ICMP error whose quoted TTL is below the floor is ignored', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined, ttlFloor: TtlFloor.of(100) });
    peer.send({ flags: 'S', sequence: 100, ttl: 200 });
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: 101, acknowledgement: synAck.sequence + 1, ttl: 200 });
    peer.dut.getTcpStack().connectOutcome(PEER_ADDRESS, 4001);
    const socket = [...(peer.dut.getTcpStack() as unknown as { sockets: Map<string, import('@/network/tcp/TcpStack').TcpSocket> }).sockets.values()]
      .find((candidate) => candidate.remotePort === peer.ports.peer && candidate.state === 'established')!;
    socket.send('hi');
    const sent = peer.last()!;
    peer.sendIcmpError('destination-unreachable', 3, sent);
    expect(socket.closed).toBe(false);
  });

  it('WITNESS: a UDP socket is not subject to the floor (no UDP code reads min_ttl)', async () => {
    const peer = scriptedPeer();
    const out = await nc(peer, `echo hi | nc -u -m 255 ${PEER_ADDRESS} 4000; echo "status=$?"`);
    expect(out.trim()).toBe('status=0');
  });
});

describe('the DSCP keywords have one table', () => {
  it('the ACL keywords, the IPsec names and nc agree on every code point', () => {
    for (const [name, value] of Object.entries(DSCP)) {
      expect(DSCP_KEYWORD_TO_VALUE[name.toLowerCase()]).toBe(value);
    }
    expect(DSCP_KEYWORD_TO_VALUE.default).toBe(0);
    expect(DSCP.EF).toBe(46);
  });
});

function pair(): { a: LinuxPC; b: LinuxPC } {
  resetCounters(); MACAddress.resetCounter(); resetDeviceCounters(); Logger.reset();
  EquipmentRegistry.resetInstance();
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  a.powerOn(); b.powerOn();
  new Cable('c').connect(a.getPorts()[0], b.getPorts()[0]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { a, b };
}

describe('nc -N tells a server that waits for the end of the input that it came', () => {
  function answeringAfterEnd(b: LinuxPC): void {
    b.getTcpStack().listen(4000, {
      allowHalfOpen: true,
      onAccept: (socket) => {
        socket.onData(() => undefined);
        socket.onEnd(() => { socket.write('reply after EOF'); socket.close(); });
      },
    });
  }

  it('with -N the reply that follows the end of the input is read', async () => {
    const { a, b } = pair();
    answeringAfterEnd(b);
    expect((await a.executeCommand('echo request | nc -N 10.0.0.2 4000')).trim()).toBe('reply after EOF');
  });

  it('without -N the same server never gets to answer', async () => {
    const { a, b } = pair();
    answeringAfterEnd(b);
    expect((await a.executeCommand('echo request | nc 10.0.0.2 4000')).trim()).toBe('');
  });

  it('-N changes nothing for a server that answers at once', async () => {
    const { a, b } = pair();
    b.getTcpStack().listen(4000, { onAccept: (socket) => { socket.onData(() => socket.write('pong')); } });
    expect((await a.executeCommand('echo ping | nc -N 10.0.0.2 4000')).trim()).toBe('pong');
    expect((await a.executeCommand('echo ping | nc 10.0.0.2 4000')).trim()).toBe('pong');
  });
});

describe('WITNESS: the lab addresses', () => {
  it('names what the probe reasons about', () => {
    expect([DUT_ADDRESS, PEER_ADDRESS, DUT_ADDRESS_V6, PEER_ADDRESS_V6]).toEqual([
      '10.0.0.1', '10.0.0.2', '2001:db8::1', '2001:db8::2',
    ]);
  });
});
