/**
 * uRPF verifie pour de bon — RFC 3704 (BCP 84).
 *
 * DISCRIMINATION : 6/11 tombent. Les 5 autres sont nommes : les deux
 * TEMOINS ; « lache accepte la source de l'autre interface », qui passait
 * parce que TOUT passait ; et les deux cas VRP de refus et d'`undo`, la
 * commande etant refusee en bloc avant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { EthernetFrame, ICMPPacket, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]) { for (const c of cmds) await d.executeCommand(c); }

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

async function laboCisco(extra: string[]) {
  const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('c1').connect(a.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
  await taper(r, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
    ...extra, 'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);
  await taper(b, ['ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1']);
  await a.executeCommand('ping -c 1 192.168.20.10');
  return { r, a, b };
}

async function traverse(extra: string[], source: string): Promise<number> {
  const { r, a, b } = await laboCisco(extra);
  let livres = 0;
  const port = b.getPort('eth0')!;
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4
      && (f.payload as IPv4Packet).sourceIP.toString() === source) livres += 1;
    return original(f as never);
  };
  r.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: r.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(new IPAddress(source), new IPAddress('192.168.20.10'),
      IP_PROTO_ICMP, 64, ECHO, 28),
  } as EthernetFrame);
  await new Promise(res => setTimeout(res, 30));
  return livres;
}

const STRICT = ['interface GigabitEthernet0/0', 'ip verify unicast reverse-path'];
const LACHE = ['interface GigabitEthernet0/0', 'ip verify unicast source reachable-via any'];

describe('uRPF jette une source qui ne peut pas venir de la', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('TEMOIN — sans uRPF, la source usurpee traverse', async () => {
    expect(await traverse([], '203.0.113.7')).toBe(1);
  });

  it('TEMOIN — avec uRPF strict, la source LEGITIME traverse', async () => {
    expect(await traverse(STRICT, '192.168.10.10')).toBe(1);
  });

  it('strict jette une source dont aucune route ne parle', async () => {
    expect(await traverse(STRICT, '203.0.113.7')).toBe(0);
  });

  it('strict jette une source qui devrait arriver par l\'AUTRE interface', async () => {
    expect(await traverse(STRICT, '192.168.20.55')).toBe(0);
  });

  it('lache accepte la source de l\'autre interface, une route existant', async () => {
    expect(await traverse(LACHE, '192.168.20.55')).toBe(1);
  });

  it('lache jette quand meme une source sans aucune route', async () => {
    expect(await traverse(LACHE, '203.0.113.7')).toBe(0);
  });

  it('la route par defaut ne suffit pas, sauf allow-default', async () => {
    const parDefaut = ['ip route 0.0.0.0 0.0.0.0 192.168.20.10'];
    expect(await traverse([...parDefaut, ...LACHE], '203.0.113.7')).toBe(0);
    expect(await traverse([...parDefaut, 'interface GigabitEthernet0/0',
      'ip verify unicast source reachable-via any allow-default'], '203.0.113.7')).toBe(1);
  });
});

describe('la commande se relit', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('IOS rend la forme moderne, allow-default compris', async () => {
    const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
    await taper(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0',
      'ip verify unicast source reachable-via any allow-default', 'end']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('ip verify unicast source reachable-via any allow-default');
  });

  it('VRP accepte `ip urpf` et le rend', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.1 255.255.255.0', 'ip urpf strict allow-default-route', 'quit']);
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ip urpf strict allow-default-route');
  });

  it('VRP refuse un mode inconnu', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0']);
    const out = await r.executeCommand('ip urpf zorglub');
    expect(out).toContain('Error');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).not.toContain('zorglub');
  });

  it('`undo ip urpf` retire le controle', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.1 255.255.255.0', 'ip urpf strict', 'undo ip urpf', 'quit']);
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).not.toContain('ip urpf');
  });
});
