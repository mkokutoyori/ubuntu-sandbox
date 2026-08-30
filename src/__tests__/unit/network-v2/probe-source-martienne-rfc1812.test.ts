/**
 * Source martienne — RFC 1812 §5.3.7. Controle pose sur le TRANSIT seul
 * (un DHCPDISCOVER a pour source 0.0.0.0).
 *
 * DISCRIMINATION : 8/10 tombent — 4 sur le comportement (les quatre
 * sources martiennes traversaient), 4 mecaniquement (`martianSource`
 * absent). Les 2 TEMOINS passent des deux cotes, et le doivent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { EthernetFrame, ICMPPacket, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { martianSource } from '@/network/layers/internet/InternetLayer';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8,
};

async function laboratoire() {
  const routeur = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('a').connect(a.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(routeur.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
  await taper(routeur, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);
  await taper(b, ['ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1']);
  await a.executeCommand('ping -c 1 192.168.20.10');
  return { routeur, a, b };
}

async function achemine(source: string): Promise<number> {
  const { routeur, a, b } = await laboratoire();
  let livres = 0;
  const port = b.getPort('eth0')!;
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4
      && (f.payload as IPv4Packet).sourceIP.toString() === source) livres += 1;
    return original(f as never);
  };
  routeur.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: routeur.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(new IPAddress(source), new IPAddress('192.168.20.10'),
      IP_PROTO_ICMP, 64, ECHO, 28),
  });
  return livres;
}

describe('les quatre sources martiennes sont jetees', () => {
  it('source MULTICAST', async () => { expect(await achemine('224.0.0.5')).toBe(0); });
  it('source DIFFUSION limitee', async () => { expect(await achemine('255.255.255.255')).toBe(0); });
  it('source BOUCLE', async () => { expect(await achemine('127.0.0.1')).toBe(0); });
  it('source NON SPECIFIEE', async () => { expect(await achemine('0.0.0.0')).toBe(0); });

  it('TEMOIN — une source ordinaire traverse', async () => {
    expect(await achemine('192.168.10.10')).toBeGreaterThan(0);
  });

  it('TEMOIN — une source d\'un AUTRE reseau legitime traverse aussi', async () => {
    expect(await achemine('8.8.8.8')).toBeGreaterThan(0);
  });
});

describe('et la regle nomme CE QUI cloche', () => {
  it('le reseau 0 est reconnu', () => {
    expect(martianSource(new IPAddress('0.0.0.0'))).toBe('network-zero');
    expect(martianSource(new IPAddress('0.1.2.3'))).toBe('network-zero');
  });

  it('le reseau 127 aussi', () => {
    expect(martianSource(new IPAddress('127.0.0.1'))).toBe('loopback');
  });

  it('et tout ce qui n\'est pas unicast', () => {
    expect(martianSource(new IPAddress('224.0.0.5'))).toBe('not-unicast');
    expect(martianSource(new IPAddress('239.1.1.1'))).toBe('not-unicast');
    expect(martianSource(new IPAddress('255.255.255.255'))).toBe('not-unicast');
    expect(martianSource(new IPAddress('240.0.0.1'))).toBe('not-unicast');
  });

  it('une source ordinaire n\'est pas martienne', () => {
    expect(martianSource(new IPAddress('192.168.1.1'))).toBeNull();
    expect(martianSource(new IPAddress('8.8.8.8'))).toBeNull();
    expect(martianSource(new IPAddress('223.255.255.255'))).toBeNull();
  });
});
