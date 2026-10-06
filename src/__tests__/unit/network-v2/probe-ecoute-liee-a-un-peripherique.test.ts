/**
 * Une ecoute peut etre liee a un peripherique (SO_BINDTODEVICE) : elle repond a ce qui arrive sur lui et a
 * rien d'autre, et `ss` le dit apres l'adresse locale (`127.0.0.53%lo:53`), ce que ni `netstat` ni
 * `/proc/net/tcp` ne font.
 *
 * Mesure de depart (946f16bb2) : le stub de systemd-resolved s'affichait `127.0.0.53:53` en TCP comme en
 * UDP, alors que la sortie reelle de `ss -lntp` sur un Ubuntu 22.04 est `127.0.0.53%lo:53` ; la pile n'avait
 * aucune notion de peripherique lie : `listen()` ignorait `boundDevice`, l'ecoute repondait a un SYN arrive
 * de n'importe quelle interface, la table des sockets n'avait pas de champ pour le peripherique, et le
 * filtre `dev` de `ss` ne selectionnait rien.
 *
 * Autorites : iproute2 v5.15.0 (`inet_addr_print` et `sock_addr_print`, lus : le peripherique est imprime
 * apres l'adresse locale et jamais apres l'adresse distante) ; noyau v5.15 (`compute_score` dans
 * `inet_hashtables.c`, lu : une ecoute liee ne correspond que si `inet_sk_bound_dev_eq` ; `sock_bindtoindex` :
 * -ENODEV pour un peripherique inconnu) ; la transcription d'un Ubuntu 22.04 pour le stub.
 *
 * Ce qui est construit : `TcpListenOptions.boundDevice` (valide a l'ecoute, evalue a chaque SYN :
 * `SegmentArrival.device` est l'interface d'arrivee, `lo` pour une livraison locale),
 * `SocketEntry.boundDevice`, `udpBindAddress(..., boundDevice)` evalue a la distribution UDP,
 * `bindDnsTcpServer` et `bindDnsUdpServer` qui le transmettent, le stub de systemd-resolved lie a `lo`,
 * l'impression de `ss` et son filtre `dev`.
 *
 * Ce qui n'est PAS construit : `udpBind`, qui lie un port a toutes les adresses, n'a pas l'option, faute
 * d'appelant ; le peripherique d'un socket IPv6 a portee de lien.
 *
 * Discrimination (fichier copie sur 946f16bb2) : HUIT cas sur dix tombent. Les deux autres passent des deux
 * cotes : un TEMOIN (une ecoute sans peripherique repond a un SYN venu du fil) et une NON-REGRESSION
 * (`netstat` et `/proc/net/tcp` n'ont jamais montre de peripherique).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { scriptedPeer, lettersOf } from '../../support/tcpScriptedPeer';

function twoMachines(): { a: LinuxPC; b: LinuxPC } {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  const a = new LinuxPC('A');
  const b = new LinuxPC('B');
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { a, b };
}

function rowOf(output: string, needle: string): string {
  return output.split('\n').find((line) => line.includes(needle)) ?? '';
}

beforeEach(() => {
  resetCounters();
});

describe('the bench is sound (witnesses)', () => {
  it('a listener bound to no device answers a SYN that arrives from the wire', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(7000, { onAccept: () => undefined });
    peer.send({ flags: 'S', sequence: 1000, destinationPort: 7000 });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });
});

describe('a listener bound to a device answers what arrives on that device and nothing else', () => {
  it('a SYN from the wire is refused by a listener bound to lo, and a local connection is accepted', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    stack.listen(7000, { onAccept: () => undefined, boundDevice: 'lo' });
    peer.send({ flags: 'S', sequence: 1000, destinationPort: 7000 });
    expect(lettersOf(peer.last()!.flags)).toContain('R');
    expect(stack.connect('127.0.0.1', 7000)?.state).toBe('established');
  });

  it('a listener bound to the wire interface refuses the local connection', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    stack.listen(7001, { onAccept: () => undefined, boundDevice: 'eth0' });
    expect(stack.connect('127.0.0.1', 7001)?.state).not.toBe('established');
    peer.send({ flags: 'S', sequence: 1000, destinationPort: 7001 });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });

  it('a device that does not exist is refused like SO_BINDTODEVICE refuses it', () => {
    const peer = scriptedPeer();
    expect(() => peer.dut.getTcpStack().listen(7002, { onAccept: () => undefined, boundDevice: 'eth9' }))
      .toThrow(/ENODEV/);
  });

  it('a datagram from the wire does not reach a UDP socket bound to lo, which the machine itself reaches', async () => {
    const { a, b } = twoMachines();
    const received: number[] = [];
    a.udpBindAddress('10.0.0.1', 7003, () => { received.push(1); }, 'probe', 'lo');
    b.sendUdpDatagram(new IPAddress('10.0.0.1'), 7003, 40000, 'x', 1);
    expect(received).toEqual([]);
    expect(await a.executeCommand('netstat -su')).toMatch(/1 packets to unknown port received/);
    a.sendUdpDatagram(new IPAddress('10.0.0.1'), 7003, 40001, 'y', 1);
    expect(received).toEqual([1]);
  });
});

describe('ss prints the device the way iproute2 does, and the other tools do not', () => {
  it('the resolver stub is 127.0.0.53%lo in TCP and in UDP, as on an Ubuntu machine', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(rowOf(await pc.executeCommand('ss -ltn'), ':53')).toMatch(/127\.0\.0\.53%lo:53/);
    expect(rowOf(await pc.executeCommand('ss -lun'), ':53')).toMatch(/127\.0\.0\.53%lo:53/);
  });

  it('only a bound listener carries the suffix, and only on its local address', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(7000, { onAccept: () => undefined, boundDevice: 'lo' });
    peer.dut.getTcpStack().listen(7001, { onAccept: () => undefined });
    const ss = await peer.dut.executeCommand('ss -ltn');
    expect(rowOf(ss, ':7000')).toMatch(/0\.0\.0\.0%lo:7000\s+0\.0\.0\.0:\*/);
    expect(rowOf(ss, ':7001')).not.toContain('%');
    expect(rowOf(ss, ':22')).not.toContain('%');
  });

  it('dev selects by the device a socket is bound to', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(7000, { onAccept: () => undefined, boundDevice: 'lo' });
    const onLo = await peer.dut.executeCommand('ss -ltn dev lo');
    expect(onLo).toContain(':7000');
    expect(onLo).toContain('127.0.0.53%lo:53');
    expect(onLo).not.toContain(':22 ');
    const onEth0 = await peer.dut.executeCommand('ss -ltn dev eth0');
    expect(onEth0).not.toContain(':7000');
    expect(onEth0).not.toContain('127.0.0.53');
  });

  it('netstat and /proc/net/tcp know no device', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(7000, { onAccept: () => undefined, boundDevice: 'lo' });
    expect(await peer.dut.executeCommand('netstat -ltn')).not.toContain('%');
    expect(await peer.dut.executeCommand('cat /proc/net/tcp')).toContain(':1B58');
    expect(await peer.dut.executeCommand('netstat -ltn')).toContain('0.0.0.0:7000');
  });

  it('closing the listener removes the row, suffix included', async () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    stack.listen(7000, { onAccept: () => undefined, boundDevice: 'lo' });
    expect(await peer.dut.executeCommand('ss -ltn')).toContain('%lo:7000');
    stack.closeListener(7000);
    expect(await peer.dut.executeCommand('ss -ltn')).not.toContain(':7000');
  });
});
