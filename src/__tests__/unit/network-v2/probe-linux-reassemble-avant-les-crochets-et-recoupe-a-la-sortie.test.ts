/**
 * Ce que les crochets de la table nat voient est le datagramme ENTIER, et ce qui sort est recoupe comme il est arrive. Des qu'une regle
 * a besoin du suivi de connexions -- une cible DNAT, SNAT, MASQUERADE ou REDIRECT, un `-m state`, un `-m conntrack` ou un `-m connmark` --,
 * `nf_defrag_ipv4` (net/ipv4/netfilter/nf_defrag_ipv4.c) remonte les fragments AVANT le suivi et AVANT la table nat (PREROUTING,
 * priorite -400) et marque le datagramme `ignore_df`. `ip_frag_reasm` (net/ipv4/ip_fragment.c) retient la taille du plus grand fragment
 * recu (`frag_max_size`) et ne laisse DF que si un fragment de cette taille le portait ; `ip_forward` compte UN datagramme transmis ;
 * `ip_fragment` et `ip_do_fragment` (net/ipv4/ip_output.c) recoupent sans depasser ni la MTU ni `frag_max_size` et comptent
 * FragOKs et FragCreates ; `ip_expire` ne repond pas « Time Exceeded » pour une file du suivi dont la destination n'est pas locale.
 * Sans regle qui ait besoin du suivi, rien n'est remonte : le routeur transmet les fragments un par un.
 *
 * Mesure de depart (arbre portant le lot precedent ; inside 10.0.0.2 -- GW -- router -- far 198.51.100.2, MASQUERADE sur eth1 de GW) :
 *     ping -s 3000 de inside vers far  ->  100 % de perte : aucun fragment ne passait la table nat, far repondait a 10.0.0.2, que
 *                                          le routeur ne sait pas joindre
 *     netstat -s sur GW  ->  aucune « reassemblies required » alors que le noyau en compte six, « forwarded » 6 au lieu de 2
 *     un ensemble de fragments qui expire sur GW pour un hote derriere lui  ->  rien n'etait compte
 *
 * Discrimination : contre l'arbre sans le lot (support et sonde conserves), 20 des 27 cas tombent et 7 passent des deux cotes : deux
 * TEMOINS (un routeur qui ne suit rien ne remonte rien ; sans aucune regle la passerelle non plus), la regle qui ne nomme aucun etat
 * de connexion (la base ne remontait jamais : coincidence), le datagramme qui tient dans la MTU (rien a recouper des deux cotes), le
 * routeur simple qui ne transmet aucune note de taille (la base n'en posait aucune : structurel), le datagramme DF dont le plus grand
 * morceau tient exactement dans la MTU de sortie (la base transmettait les morceaux tels quels : coincidence) et le fragment destine a
 * une autre adresse, que l'hote qui ne relaie pas ne compte pas (non-regression : la base ne le comptait pas davantage).
 * Le fichier voisin, ipv4-reassembly-bookkeeping, tient la comptabilite du reassembleur : 5 de ses 11 cas tombent, les six autres
 * sont des temoins ou des regles que le premier fragment et le plus grand fragment decident de la meme facon.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, MACAddress, SubnetMask, ETHERTYPE_IPV4, IP_PROTO_ICMP, createIPv4Packet, resetCounters,
} from '@/network/core/types';
import type { EthernetFrame, ICMPPacket, IPv4Packet } from '@/network/core/types';
import { fragmentIPv4, IPV4_FLAG_DF, REASSEMBLY_TIMEOUT_MS } from '@/network/core/Ipv4Fragmentation';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { framesSentOn } from '../../support/wireWatch';
import {
  natGateway, natPath, sudo, flows, watchSources, FAR_IP, GATEWAY_OUTSIDE_IP, INSIDE_IP, GATEWAY_INSIDE_IP, type Host,
} from '../../support/natGateway';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface IpCounters {
  readonly forwarded: number;
  readonly reassemblyRequired: number;
  readonly reassembled: number;
  readonly reassemblyFailed: number;
  readonly fragmented: number;
  readonly fragmentsCreated: number;
}

async function ipCounters(host: Host): Promise<IpCounters> {
  const listing = await sudo(host, 'netstat -s');
  const read = (label: string): number => Number(new RegExp(`^\\s*(\\d+) ${label}`, 'm').exec(listing)?.[1] ?? 0);
  return {
    forwarded: read('forwarded'),
    reassemblyRequired: read('reassemblies required'),
    reassembled: read('packets reassembled ok'),
    reassemblyFailed: read('packet reassemblies failed'),
    fragmented: read('fragments received ok'),
    fragmentsCreated: read('fragments created'),
  };
}

const bigPing = (host: Host, target: string, size = 3000): Promise<string> =>
  pingOnSimulatedClock(host, `ping -c 1 -W 2 -s ${size} ${target}`);
const masquerade = 'iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE';

describe('what the nat hooks see is the whole datagram, and what leaves is cut as it arrived', () => {
  it('TEMOIN : a router that tracks nothing forwards the fragments one by one', async () => {
    const { gateway, router } = await natPath();
    expect(await bigPing(gateway, FAR_IP)).toContain('1 received');
    expect(await ipCounters(router)).toMatchObject({ forwarded: 6, reassemblyRequired: 0, reassembled: 0, fragmented: 0 });
  });

  it('a ping bigger than the MTU goes through a MASQUERADE gateway and is answered', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    const text = await bigPing(inside, FAR_IP);
    expect(text).toContain('3008 bytes from 198.51.100.2');
    expect(text).toContain('1 packets transmitted, 1 received, 0% packet loss');
  });

  it('the gateway reassembles each datagram once, and forwards it once', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    await bigPing(inside, FAR_IP);
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 2, reassemblyRequired: 6, reassembled: 2, reassemblyFailed: 0 });
  });

  it('it cuts each datagram again into the pieces it came in', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    await bigPing(inside, FAR_IP);
    expect(await ipCounters(gateway)).toMatchObject({ fragmented: 2, fragmentsCreated: 6 });
  });

  it('the plain router behind it still sees fragments, one by one', async () => {
    const { inside, gateway, router } = await natPath();
    await sudo(gateway, masquerade);
    await bigPing(inside, FAR_IP);
    expect(await ipCounters(router)).toMatchObject({ forwarded: 6, reassemblyRequired: 0 });
  });

  it('the plain router forwards the pieces without the size note the gateway kept for the datagram', async () => {
    const { inside, gateway, router } = await natPath();
    await sudo(gateway, masquerade);
    const forwarded = framesSentOn(router, 'eth1');
    await bigPing(inside, FAR_IP);
    const pieces = forwarded.map((frame) => frame.payload as IPv4Packet).filter((packet) => packet.type === 'ipv4');
    expect(pieces.map((piece) => piece.totalLength)).toEqual([1500, 1500, 68]);
    expect(pieces.filter((piece) => piece.largestFragmentBytes !== undefined)).toEqual([]);
  });

  it('the far host receives one datagram, from the translated address only', async () => {
    const { inside, gateway, far } = await natPath();
    await sudo(gateway, masquerade);
    const seen = await watchSources(far, 'icmp', GATEWAY_OUTSIDE_IP, INSIDE_IP);
    await bigPing(inside, FAR_IP);
    expect(await seen()).toEqual({ [GATEWAY_OUTSIDE_IP]: 1, [INSIDE_IP]: 0 });
  });

  it('the gateway keeps one flow for the whole datagram, with the translated reply tuple', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    await bigPing(inside, FAR_IP);
    const kept = await flows(gateway, '-p', 'icmp');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/src=10\.0\.0\.2 dst=198\.51\.100\.2 type=8 code=0 id=\d+ src=198\.51\.100\.2 dst=203\.0\.113\.1 type=0 code=0 id=\d+/);
  });

  it('a DNAT rewrites a fragmented echo for the inside host, and the reply is answered from the address that was pinged', async () => {
    const { gateway, outside, inside } = await natGateway();
    await sudo(gateway, `iptables -t nat -A PREROUTING -p icmp -d ${GATEWAY_OUTSIDE_IP} -j DNAT --to-destination ${INSIDE_IP}`);
    const text = await bigPing(outside, GATEWAY_OUTSIDE_IP);
    expect(text).toContain(`3008 bytes from ${GATEWAY_OUTSIDE_IP}`);
    expect(await ipCounters(inside)).toMatchObject({ reassemblyRequired: 3, reassembled: 1 });
  });

  it('a datagram for the gateway itself is reassembled once, whatever the rules in front of it', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    expect(await bigPing(inside, GATEWAY_INSIDE_IP)).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 0, reassemblyRequired: 3, reassembled: 1 });
  });
});

describe('the gateway reassembles when something needs the connection tracker, and only then', () => {
  it('TEMOIN : with no rule at all it forwards the pieces as they are', async () => {
    const { inside, gateway } = await natGateway();
    expect(await bigPing(inside, '203.0.113.2')).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 6, reassemblyRequired: 0 });
  });

  it.each([
    ['a conntrack match', 'iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'],
    ['a state match', 'iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT'],
    ['a connmark match', 'iptables -A FORWARD -m connmark --mark 7 -j ACCEPT'],
  ])('%s is enough', async (_, rule) => {
    const { inside, gateway } = await natGateway();
    await sudo(gateway, rule);
    expect(await bigPing(inside, '203.0.113.2')).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 2, reassemblyRequired: 6, reassembled: 2 });
  });

  it('a rule that names no connection state does not make it reassemble', async () => {
    const { inside, gateway } = await natGateway();
    await sudo(gateway, 'iptables -A FORWARD -p icmp -j ACCEPT');
    expect(await bigPing(inside, '203.0.113.2')).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 6, reassemblyRequired: 0 });
  });

  it('flushing the nat table stops it', async () => {
    const { inside, gateway } = await natGateway();
    await sudo(gateway, masquerade);
    await bigPing(inside, '203.0.113.2');
    const before = await ipCounters(gateway);
    expect(before.reassemblyRequired).toBe(6);
    await sudo(gateway, 'iptables -t nat -F');
    await bigPing(inside, '203.0.113.2');
    const after = await ipCounters(gateway);
    expect(after.reassemblyRequired).toBe(6);
    expect(after.forwarded).toBe(before.forwarded + 6);
  });
});

describe('the pieces going out are no bigger than the MTU, and no bigger than the pieces that came in', () => {
  it('a smaller MTU on the way out cuts the datagram smaller', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    await sudo(gateway, 'ip link set dev eth1 mtu 1000');
    expect(await bigPing(inside, FAR_IP)).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ fragmented: 2, fragmentsCreated: 4 + 3 });
  });

  it('a bigger MTU on the way out still cuts it as the sender did', async () => {
    const { inside, gateway, far } = await natPath();
    await sudo(gateway, masquerade);
    await sudo(gateway, 'ip link set dev eth1 mtu 9000');
    expect(await bigPing(inside, FAR_IP)).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ fragmented: 2, fragmentsCreated: 3 + 3 });
    expect((await ipCounters(far)).reassemblyRequired).toBe(3);
  });

  it('a datagram cut into two pieces is one fragmented datagram and two pieces created', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    expect(await bigPing(inside, FAR_IP, 2000)).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 2, reassemblyRequired: 4, reassembled: 2, fragmented: 2, fragmentsCreated: 4 });
  });

  it('a datagram that fits is not cut at all, DF or not', async () => {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    expect(await pingOnSimulatedClock(inside, `ping -c 1 -W 2 -M do -s 1472 ${FAR_IP}`)).toContain('1 received');
    expect(await ipCounters(gateway)).toMatchObject({ forwarded: 2, reassemblyRequired: 0, fragmented: 0 });
  });
});

describe('a datagram put back together is refused with DF only if the way out is smaller than its largest piece', () => {
  const echo: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 3000 };
  const piecesOf = (flags: number): IPv4Packet[] => {
    const whole = createIPv4Packet(new IPAddress(INSIDE_IP), new IPAddress(FAR_IP), IP_PROTO_ICMP, 64, echo, 3008, { flags });
    return fragmentIPv4({ ...whole, identification: 4242 }, 1500);
  };
  const datagramsOf = (frames: EthernetFrame[]): IPv4Packet[] =>
    frames.map((frame) => frame.payload as IPv4Packet).filter((packet) => packet.type === 'ipv4');

  async function offer(flags: number, wayOutMtu: number): Promise<{ out: number[]; refusals: string[] }> {
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    await sudo(gateway, `ip link set dev eth1 mtu ${wayOutMtu}`);
    const wayOut = framesSentOn(gateway, 'eth1');
    const wayBack = framesSentOn(gateway, 'eth0');
    const port = gateway.getPort('eth0')!;
    for (const piece of piecesOf(flags)) {
      port.receiveFrame({ srcMAC: inside.getPort('eth0')!.getMAC(), dstMAC: port.getMAC(), etherType: ETHERTYPE_IPV4, payload: piece });
    }
    return {
      out: datagramsOf(wayOut).map((packet) => packet.totalLength),
      refusals: datagramsOf(wayBack)
        .map((packet) => packet.payload as ICMPPacket)
        .filter((icmp) => icmp.type === 'icmp' && icmp.icmpType === 'destination-unreachable')
        .map((icmp) => `${icmp.icmpType}/${icmp.code}`),
    };
  }

  it('TEMOIN : without DF it is cut again to fit a smaller way out', async () => {
    expect(await offer(0, 1400)).toEqual({ out: [1396, 1396, 276], refusals: [] });
  });

  it('with DF on every piece, a way out as large as the largest piece takes it, cut as it came', async () => {
    expect(await offer(IPV4_FLAG_DF, 1500)).toEqual({ out: [1500, 1500, 68], refusals: [] });
  });

  it('with DF on every piece, a way out smaller than the largest piece gets Fragmentation needed instead', async () => {
    expect(await offer(IPV4_FLAG_DF, 1400)).toEqual({ out: [], refusals: ['destination-unreachable/4'] });
  });
});

describe('a host that does not forward counts no reassembly for a fragment that is not meant for it', () => {
  const WINDOWS_IP = '10.0.0.5';
  const PEER_IP = '10.0.0.6';

  async function reassembliesRequiredAfterOneFragmentFor(destination: string): Promise<number> {
    const windows = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const peer = new LinuxPC('linux-pc', 'PEER');
    const mask = new SubnetMask('255.255.255.0');
    windows.configureInterface('eth0', new IPAddress(WINDOWS_IP), mask);
    peer.configureInterface('eth0', new IPAddress(PEER_IP), mask);
    new Cable('link').connect(windows.getPort('eth0')!, peer.getPort('eth0')!);
    const echo: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 1400 };
    const whole = createIPv4Packet(new IPAddress(PEER_IP), new IPAddress(destination), IP_PROTO_ICMP, 64, echo, 1408, { flags: 0 });
    const port = windows.getPort('eth0')!;
    port.receiveFrame({
      srcMAC: peer.getPort('eth0')!.getMAC(), dstMAC: port.getMAC(), etherType: ETHERTYPE_IPV4,
      payload: fragmentIPv4({ ...whole, identification: 4242 }, 600)[0],
    });
    const listing = await windows.executeCommand('netstat -s -p ip');
    return Number(/Reassembly Required\s+= (\d+)/.exec(listing)?.[1]);
  }

  it('TEMOIN : a fragment meant for the host is counted', async () => {
    expect(await reassembliesRequiredAfterOneFragmentFor(WINDOWS_IP)).toBe(1);
  });

  it('a fragment meant for another address is not', async () => {
    expect(await reassembliesRequiredAfterOneFragmentFor('10.0.0.77')).toBe(0);
  });
});

describe('a datagram that never completes dies at the gateway as the kernel lets it die', () => {
  const pieceOf = (destination: string, identification: number): IPv4Packet => {
    const echo: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 1400 };
    const whole = createIPv4Packet(new IPAddress(INSIDE_IP), new IPAddress(destination), IP_PROTO_ICMP, 64, echo, 1408, { flags: 0 });
    return fragmentIPv4({ ...whole, identification }, 600)[0];
  };

  async function offerAndLetExpire(destination: string): Promise<{ answers: string[]; failed: number }> {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    const { inside, gateway } = await natPath();
    await sudo(gateway, masquerade);
    const answers: string[] = [];
    gateway.getBus().subscribe('port.frame.tx-requested', (event: unknown) => {
      const frame = (event as { payload?: { frame?: EthernetFrame } }).payload?.frame;
      const icmp = (frame?.payload as IPv4Packet | undefined)?.payload as ICMPPacket | undefined;
      if (icmp?.type === 'icmp' && icmp.icmpType === 'time-exceeded') answers.push(`${icmp.icmpType}/${icmp.code}`);
    });
    const port = gateway.getPort('eth0')!;
    const deliver = (piece: IPv4Packet): void => {
      port.receiveFrame({ srcMAC: inside.getPort('eth0')!.getMAC(), dstMAC: port.getMAC(), etherType: ETHERTYPE_IPV4, payload: piece });
    };
    deliver(pieceOf(destination, 4242));
    clock.advance(REASSEMBLY_TIMEOUT_MS + 1000);
    deliver(pieceOf(destination, 4243));
    return { answers, failed: (await ipCounters(gateway)).reassemblyFailed };
  }

  it('for a host behind it : nothing is sent back, the failure is counted', async () => {
    expect(await offerAndLetExpire(FAR_IP)).toEqual({ answers: [], failed: 1 });
  });

  it('for the gateway itself : Time Exceeded, code 1, goes back to the sender', async () => {
    expect(await offerAndLetExpire(GATEWAY_INSIDE_IP)).toEqual({ answers: ['time-exceeded/1'], failed: 1 });
  });
});
