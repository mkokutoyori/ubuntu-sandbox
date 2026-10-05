/**
 * Une prise UDP connectee a une adresse IPv6 : le datagramme part, et l'erreur
 * ICMPv6 qui revient devient l'erreur de la prise, comme sur Linux.
 *
 * Mesure de depart (commit precedent) :
 *
 *   - `EndHost.udpConnect` ne prenait qu'une `IPAddress` : `nc -u -6` etait
 *     refuse avec « this simulator cannot build a connected UDP socket over
 *     IPv6 », et aucune application ne pouvait ouvrir une prise UDP connectee
 *     vers un pair IPv6 ;
 *   - une erreur ICMPv6 ne parvenait a aucune prise : la prise IPv4 connectee
 *     retenait deja « connection refused » apres un « port unreachable », la
 *     version IPv6 n'existait pas ;
 *   - `nc -s` ne savait pas imposer une adresse source IPv6 : une adresse IPv6
 *     etait refusee en « Name or service not known » (le texte n'etait lu que
 *     comme une adresse IPv4), une source IPv4 pour une destination IPv6 en TCP
 *     faisait planter `tcpExchange` (statut 127, aucune sortie), et en UDP elle
 *     rendait « bind failed: Cannot assign requested address ».
 *
 * Autorite : la source du noyau Linux et celle de `nc`, lues
 * (raw.githubusercontent.com). `net/ipv6/icmp.c`, `icmpv6_err_convert` :
 * Destination Unreachable code 0 ENETUNREACH non fatal, 1 EACCES fatal, 2 et 3
 * EHOSTUNREACH non fatals, 4 ECONNREFUSED fatal, 5 et 6 EACCES fatals, un code
 * inconnu EPROTO fatal ; Packet Too Big EMSGSIZE ; Time Exceeded EHOSTUNREACH
 * non fatal. `net/ipv6/udp.c`, `udpv6_err` : sur une prise connectee, une
 * erreur FATALE est retenue (`sk->sk_err`) et rendue par le prochain appel ; un
 * Packet Too Big est fatal tant que la prise n'a pas demande
 * `IPV6_PMTUDISC_DONT`, ce qui est le defaut du noyau (`IPV6_PMTUDISC_WANT`).
 * RFC 8200 §4 et §3 : la charge IPv6 tient sur 16 bits, donc 65 527 octets de
 * donnees UDP au plus sans jumbogramme. `net/ipv4/af_inet.c` (`__inet_bind`) et
 * `net/ipv6/af_inet6.c` (`__inet6_bind`) : une adresse d'une autre famille rend
 * EAFNOSUPPORT, une adresse que la machine ne porte pas EADDRNOTAVAIL.
 * `netcat.c` (`remote_connect`) : la source de `-s` est resolue par
 * `getaddrinfo` avec le `ai_family` de la destination, et un echec s'imprime
 * « getaddrinfo: <gai_strerror> ». glibc (`nss/getaddrinfo.c`) rend
 * EAI_ADDRFAMILY, « Address family for hostname not supported », pour une
 * adresse IPv4 demandee en AF_INET6 sans AI_V4MAPPED, et pour une adresse IPv6
 * demandee en AF_INET.
 *
 * Ce qui est construit : `udpConnect` prend les deux familles, `send` emprunte
 * `sendUdpDatagram6`, `reportUdpSocketError6` rattache l'erreur a la prise par
 * son numero de port source et son destinataire cite, `udpSocketErrorForV6`
 * porte la table du noyau a cote de celle d'IPv4 ; l'adresse liee est celle de
 * la source des datagrammes (`emitIpv6` accepte une source imposee), une
 * adresse d'une autre famille rend EAFNOSUPPORT, une adresse que la machine ne
 * porte pas EADDRNOTAVAIL ; `tcpExchange` impose la source des deux familles et
 * refuse l'autre famille ; `nc` lit la source de `-s` dans la famille de la
 * destination, comme `netcat.c`, et `nc -u -6` n'est plus refuse.
 *
 * Discrimination (fichier copie sur le commit precedent, avec l'aide
 * `tcpScriptedPeer.ts` etendue) : TRENTE-CINQ cas sur trente-neuf tombent. Les
 * QUATRE autres passent des deux cotes : trois TEMOINS (le laboratoire voit un
 * datagramme IPv6 envoye comme toute application l'envoie deja ; la meme
 * epreuve `nc -u -z` en IPv4 echoue de la meme facon ; sans `-s`, la meme
 * connexion TCP aboutit chez l'ecouteur) et une NON-REGRESSION (une source IPv4
 * pour une destination IPv4 reste la source de la connexion). Tout le reste
 * passe par `udpConnect` ou par `nc -s`, qui refusaient une adresse IPv6.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  scriptedPeer, PEER_ADDRESS, PEER_ADDRESS_V6, DUT_ADDRESS_V6, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import {
  ETHERTYPE_IPV4, IP_PROTO_UDP, IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters, type IPv4Packet,
} from '@/network/core/types';
import { DiffServField, HopLimit, TimeToLive } from '@/network/core/IpHeaderFields';
import type { ConnectedUdpSocket } from '@/network/devices/EndHost';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const REMOTE = new IPv6Address(PEER_ADDRESS_V6);
const REMOTE_PORT = 5353;

function connected(peer: ScriptedPeer): ConnectedUdpSocket {
  const socket = peer.dut.udpConnect(REMOTE, REMOTE_PORT);
  if (typeof socket === 'string') throw new Error(`udpConnect refused: ${socket}`);
  return socket;
}

function firstDatagram(peer: ScriptedPeer) {
  return peer.udpDatagrams().at(-1)!;
}

describe('a UDP socket connected to an IPv6 address (net/ipv6/udp.c)', () => {
  it('WITNESS: the lab sees an IPv6 datagram sent the way every application already sends one', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    expect(peer.dut.sendUdpDatagram6(REMOTE, REMOTE_PORT, 40000, 'hello', 5)).toBe(true);
    expect(firstDatagram(peer).destinationIP.toString()).toBe(PEER_ADDRESS_V6);
  });

  it('WITNESS: connect, send, and the datagram reaches the wire addressed to the peer', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = connected(peer);
    expect(socket.send(new TextEncoder().encode('hello'))).toBeNull();
    const datagram = firstDatagram(peer);
    expect(datagram.destinationIP.toString()).toBe(PEER_ADDRESS_V6);
    expect(datagram.payload).toMatchObject({ type: 'udp', destinationPort: REMOTE_PORT, sourcePort: socket.localPort });
  });

  it('a destination without a route is refused at connect time', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    expect(peer.dut.udpConnect(new IPv6Address('2001:db9::1'), REMOTE_PORT)).toBe('ENETUNREACH');
  });

  it('an IPv4 source address cannot be bound for an IPv6 peer: the address family differs', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    expect(peer.dut.udpConnect(REMOTE, REMOTE_PORT, { source: new IPAddress('10.0.0.1') })).toBe('EAFNOSUPPORT');
  });

  it('an IPv6 source address the machine does not own cannot be bound', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    expect(peer.dut.udpConnect(REMOTE, REMOTE_PORT, { source: new IPv6Address('2001:db8::dead') })).toBe('EADDRNOTAVAIL');
  });

  it('a datagram larger than 65527 bytes is refused, 65527 is sent', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = connected(peer);
    expect(socket.send(new Uint8Array(65_528))).toBe('EMSGSIZE');
    expect(socket.send(new Uint8Array(65_527))).toBeNull();
  });
});

describe('the source address of a connected socket is the one asked for', () => {
  const ALIAS = '2001:db8::99';

  function withAlias(): ScriptedPeer {
    const peer = scriptedPeer('linux', 'ipv6');
    peer.dut.configureIPv6Interface('eth0', new IPv6Address(ALIAS), 64);
    return peer;
  }

  it.each([[DUT_ADDRESS_V6], [ALIAS]])('the datagram leaves from %s when that address is bound', (source) => {
    const peer = withAlias();
    const socket = peer.dut.udpConnect(REMOTE, REMOTE_PORT, { source: new IPv6Address(source) });
    if (typeof socket === 'string') throw new Error(`udpConnect refused: ${socket}`);
    expect(socket.send(new TextEncoder().encode('hello'))).toBeNull();
    expect(firstDatagram(peer).sourceIP.toString()).toBe(source);
  });
});

describe('an ICMPv6 error becomes the error of the connected socket (icmpv6_err_convert, udpv6_err)', () => {
  function afterError(
    icmpType: Parameters<ScriptedPeer['sendIcmpv6ErrorQuoting']>[0], code: number, mtu?: number,
  ): { first: ReturnType<ConnectedUdpSocket['send']>; second: ReturnType<ConnectedUdpSocket['send']> } {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = connected(peer);
    socket.send(new TextEncoder().encode('probe'));
    peer.sendIcmpv6ErrorQuoting(icmpType, code, firstDatagram(peer), mtu);
    return { first: socket.send(new TextEncoder().encode('again')), second: socket.send(new TextEncoder().encode('and again')) };
  }

  it.each([
    [4, 'ECONNREFUSED'],
    [1, 'EACCES'],
    [5, 'EACCES'],
    [6, 'EACCES'],
    [9, 'EPROTO'],
  ])('destination unreachable code %i is fatal: the next send fails with %s, once', (code, errno) => {
    const { first, second } = afterError('destination-unreachable', code);
    expect(first).toBe(errno);
    expect(second).toBeNull();
  });

  it.each([[0], [2], [3]])('destination unreachable code %i is not fatal: sending goes on', (code) => {
    expect(afterError('destination-unreachable', code).first).toBeNull();
  });

  it('time exceeded is not fatal', () => {
    expect(afterError('time-exceeded', 0).first).toBeNull();
  });

  it('Packet Too Big is fatal for a socket that did not ask to ignore the path MTU', () => {
    expect(afterError('packet-too-big', 0, 1400).first).toBe('EMSGSIZE');
  });

  it('an error that quotes another destination port leaves the socket alone', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = connected(peer);
    socket.send(new TextEncoder().encode('probe'));
    const quoted = firstDatagram(peer);
    const stranger = { ...quoted, payload: { ...(quoted.payload as object), destinationPort: REMOTE_PORT + 1 } };
    peer.sendIcmpv6ErrorQuoting('destination-unreachable', 4, stranger as typeof quoted);
    expect(socket.send(new TextEncoder().encode('again'))).toBeNull();
  });

  it('a closed socket forgets its error and its port', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = connected(peer);
    socket.send(new TextEncoder().encode('probe'));
    peer.sendIcmpv6ErrorQuoting('destination-unreachable', 4, firstDatagram(peer));
    socket.close();
    const reopened = peer.dut.udpConnect(REMOTE, REMOTE_PORT);
    expect(typeof reopened).toBe('object');
    expect((reopened as ConnectedUdpSocket).send(new TextEncoder().encode('fresh'))).toBeNull();
  });
});

describe('a connected socket sends with the TTL, hop limit and DiffServ it was given', () => {
  it('over IPv6: hop limit and traffic class, a hop limit of 0 included', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = peer.dut.udpConnect(REMOTE, REMOTE_PORT, { ttl: HopLimit.of(0), diffServ: DiffServField.of(0xb8) });
    expect(typeof socket).toBe('object');
    (socket as ConnectedUdpSocket).send(new TextEncoder().encode('x'));
    const sent = firstDatagram(peer);
    expect([sent.hopLimit, sent.trafficClass]).toEqual([0, 0xb8]);
  });

  it('over IPv4: TTL and TOS', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.udpConnect(new IPAddress(PEER_ADDRESS), REMOTE_PORT, {
      ttl: TimeToLive.of(9), diffServ: DiffServField.of(0xc0),
    });
    (socket as ConnectedUdpSocket).send(new TextEncoder().encode('x'));
    const sent = peer.frames
      .filter((frame) => frame.etherType === ETHERTYPE_IPV4)
      .map((frame) => frame.payload as IPv4Packet)
      .filter((packet) => packet.protocol === IP_PROTO_UDP
        && (packet.payload as { destinationPort?: number }).destinationPort === REMOTE_PORT);
    expect(sent.map((packet) => [packet.ttl, packet.tos])).toEqual([[9, 0xc0]]);
  });

  it('WITNESS: without options the defaults go out', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    connected(peer).send(new TextEncoder().encode('x'));
    const sent = firstDatagram(peer);
    expect([sent.hopLimit, sent.trafficClass]).toEqual([64, 0]);
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
  a.addStaticNeighbor6(new IPv6Address('2001:db8::2'), b.getPorts()[0].getMAC(), 'eth0');
  b.addStaticNeighbor6(new IPv6Address('2001:db8::1'), a.getPorts()[0].getMAC(), 'eth0');
  return { a, b };
}

describe('nc -u over IPv6 between two machines on a real cable', () => {
  beforeEach(() => { EquipmentRegistry.resetInstance(); });

  it('a closed UDP port fails the -z test: the second datagram meets the ICMPv6 error', async () => {
    const { a } = pair();
    const output = await a.executeCommand('nc -u -z -v 2001:db8::2 40123; echo "status=$?"');
    expect(output.trim()).toBe('status=1');
  });

  it('WITNESS: a port with a listener answers nothing, so the same test succeeds', async () => {
    const { a, b } = pair();
    b.udpListen(40123, 'listener', {});
    const output = await a.executeCommand('nc -u -z -v 2001:db8::2 40123; echo "status=$?"');
    expect(output).toMatch(/Connection to 2001:db8::2 40123 port \[udp\/\*\] succeeded!/);
    expect(output).toMatch(/status=0/);
  });

  it('WITNESS: the same test over IPv4 fails the same way', async () => {
    const { a } = pair();
    const output = await a.executeCommand('nc -u -z -v 10.0.0.2 40123; echo "status=$?"');
    expect(output.trim()).toBe('status=1');
  });
});

describe('nc -s names the source of the connection, whatever the family (netcat.c remote_connect)', () => {
  const ALIAS = '2001:db8::99';

  function labWithAlias(): { a: LinuxPC; b: LinuxPC } {
    const lab = pair();
    lab.a.configureIPv6Interface('eth0', new IPv6Address(ALIAS), 64);
    lab.b.addStaticNeighbor6(new IPv6Address(ALIAS), lab.a.getPorts()[0].getMAC(), 'eth0');
    return lab;
  }

  it('WITNESS: without -s the same TCP connection reaches the listener', async () => {
    const { a, b } = labWithAlias();
    const seen: string[] = [];
    b.getTcpStack().listen(4444, { onAccept: (socket) => { seen.push(socket.remoteIp); } });
    const output = await a.executeCommand('nc -zv 2001:db8::2 4444; echo "status=$?"');
    expect(output).toMatch(/succeeded!/);
    expect(seen).toHaveLength(1);
  });

  it('NON-REGRESSION: an IPv4 source for an IPv4 destination is still the source of the connection', async () => {
    const { a, b } = labWithAlias();
    const seen: string[] = [];
    b.getTcpStack().listen(4444, { onAccept: (socket) => { seen.push(socket.remoteIp); } });
    const output = await a.executeCommand('nc -zv -s 10.0.0.1 10.0.0.2 4444; echo "status=$?"');
    expect(output).toMatch(/succeeded!/);
    expect(seen).toEqual(['10.0.0.1']);
  });

  it.each([['2001:db8::1'], [ALIAS]])('UDP: the datagram arrives from %s', async (source) => {
    const { a, b } = labWithAlias();
    const seen: string[] = [];
    b.udpBind(40123, (delivery) => { seen.push(delivery.sourceIP.toString()); });
    await a.executeCommand(`echo hello | nc -u -s ${source} 2001:db8::2 40123`);
    expect(seen).toEqual([source]);
  });

  it.each([['2001:db8::1'], [ALIAS]])('TCP: the connection comes from %s', async (source) => {
    const { a, b } = labWithAlias();
    const seen: string[] = [];
    b.getTcpStack().listen(4444, { onAccept: (socket) => { seen.push(socket.remoteIp); } });
    const output = await a.executeCommand(`nc -zv -s ${source} 2001:db8::2 4444; echo "status=$?"`);
    expect(output).toMatch(/succeeded!/);
    expect(seen).toEqual([source]);
  });

  it.each([
    ['nc -zv -s 10.0.0.1 -6 2001:db8::2 4444'],
    ['nc -zv -s 10.0.0.1 2001:db8::2 4444'],
    ['nc -u -zv -s 10.0.0.1 2001:db8::2 40123'],
    ['nc -zv -s 2001:db8::1 10.0.0.2 4444'],
    ['nc -u -zv -s 2001:db8::1 10.0.0.2 40123'],
  ])('%s: the source is of another family than the destination', async (command) => {
    const { a } = labWithAlias();
    const output = await a.executeCommand(`${command}; echo "status=$?"`);
    expect(output.trim()).toBe('nc: getaddrinfo: Address family for hostname not supported\nstatus=1');
  });

  it.each([['nc -zv -s 2001:db8::dead 2001:db8::2 4444'], ['nc -u -zv -s 2001:db8::dead 2001:db8::2 40123']])(
    '%s: an address the machine does not own cannot be bound', async (command) => {
      const { a } = labWithAlias();
      const output = await a.executeCommand(`${command}; echo "status=$?"`);
      expect(output.trim()).toBe('nc: bind failed: Cannot assign requested address\nstatus=1');
    });
});
