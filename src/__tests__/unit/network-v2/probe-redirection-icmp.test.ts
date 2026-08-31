/**
 * `no ip redirects` coupe, et une redirection ne repond pas a une erreur.
 *
 * RFC 1812 §4.3.1 classe Redirect parmi les ICMP error messages, et
 * §4.3.2.7 : « An ICMP error message MUST NOT be sent as the result of
 * receiving: o An ICMP error message … » — MUST NOT.
 *
 * DISCRIMINATION : 2/6 tombent. Les 4 autres sont nommes plutot que
 * comptes : le TEMOIN ; le fragment et la source martienne, ecartes plus
 * haut sur d'autres chemins ; et `ip redirects`, qui passait pour une
 * raison qui ne prouve rien — la redirection partait de toute facon.
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

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]) { for (const c of cmds) await d.executeCommand(c); }

async function redirections(opts: {
  extra?: string[]; source?: string; charge?: ICMPPacket; fragment?: boolean;
}): Promise<number> {
  const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  new Cable('c1').connect(a.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  await taper(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.9.9.0 255.255.255.0 192.168.10.2', ...(opts.extra ?? []), 'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);

  let vues = 0;
  r.getBus().subscribe('port.frame.tx-requested', (e: unknown) => {
    const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
    const ic = (f?.payload as IPv4Packet | undefined)?.payload as ICMPPacket | undefined;
    if (ic && ic.type === 'icmp' && ic.icmpType === 'redirect') vues += 1;
  });

  const charge: ICMPPacket = opts.charge ?? {
    type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
  };
  const pkt = createIPv4Packet(
    new IPAddress(opts.source ?? '192.168.10.10'), new IPAddress('10.9.9.9'),
    IP_PROTO_ICMP, 64, charge, 8);
  if (opts.fragment) {
    (pkt as unknown as { fragmentOffset: number }).fragmentOffset = 185;
    (pkt as unknown as { flags: number }).flags = 0;
  }
  r.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: r.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4, payload: pkt,
  } as EthernetFrame);
  await new Promise(res => setTimeout(res, 30));
  return vues;
}

const ERREUR: ICMPPacket = {
  type: 'icmp', icmpType: 'destination-unreachable', code: 1, id: 0, sequence: 0, dataSize: 8,
};

describe('la redirection ICMP obeit a ce qui la gouverne', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('TEMOIN — une redirection part quand elle doit', async () => {
    expect(await redirections({})).toBe(1);
  });

  it('`no ip redirects` la coupe', async () => {
    expect(await redirections({
      extra: ['interface GigabitEthernet0/0', 'no ip redirects'],
    })).toBe(0);
  });

  it('et `ip redirects` la rend', async () => {
    expect(await redirections({
      extra: ['interface GigabitEthernet0/0', 'no ip redirects', 'ip redirects'],
    })).toBe(1);
  });

  it('on ne redirige pas en reponse a une ERREUR icmp', async () => {
    expect(await redirections({ charge: ERREUR })).toBe(0);
  });

  it('ni sur un fragment non initial', async () => {
    expect(await redirections({ fragment: true })).toBe(0);
  });

  it('ni pour une source martienne', async () => {
    expect(await redirections({ source: '224.0.0.5' })).toBe(0);
  });
});
