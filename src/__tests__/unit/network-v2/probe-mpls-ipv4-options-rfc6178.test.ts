/**
 * Probe: IPv4 packets with header options are label-switched like any other
 * (docs/rfc/mpls/rfc6178.txt §4): the ingress LER decides on imposition and the
 * label values without considering the IPv4 options, and a Router Alert option
 * does not force the Router Alert label.
 * Non-regression probe: the forwarding path already behaves so, so all 4 cases pass
 * before as well; the 'no option' case is the witness that proves the lab. The discriminating case is the transit
 * LSR: it must see a labelled packet, not an IPv4 option packet routed through it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { buildRecordRouteOption } from '@/network/layers/internet/Ipv4Options';
import {
  IPAddress, ETHERTYPE_IPV4, IP_PROTO_ICMP, createIPv4Packet, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return work;
}

async function lab() {
  const ce1 = new LinuxPC('linux-pc', 'CE1');
  const ce2 = new LinuxPC('linux-pc', 'CE2');
  const [r1, r2, r3] = [new CiscoRouter('R1'), new CiscoRouter('R2'), new CiscoRouter('R3')];
  new Cable('a').connect(ce1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(r3.getPort('GigabitEthernet0/1')!, ce2.getPort('eth0')!);
  await run(r1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.2.0 255.255.255.0 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2']);
  await run(r2, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.2.0 255.255.255.0 10.23.0.3', 'ip route 192.168.1.0 255.255.255.0 10.12.0.1',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(r3, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.0 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2']);
  await ce1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await ce1.executeCommand('sudo ip route add default via 192.168.1.1');
  await ce2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await ce2.executeCommand('sudo ip route add default via 192.168.2.1');
  for (const [router, iface] of [[r1, 'GigabitEthernet0/1'], [r2, 'GigabitEthernet0/0'], [r2, 'GigabitEthernet0/1'], [r3, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(6000);
  clock.advance(20000);
  return { ce1, r1, r2, r3 };
}


function optionPacket(source: string, destination: string, ipOptions: IPv4Option[]): IPv4Packet {
  const icmp: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 32 };
  return createIPv4Packet(new IPAddress(source), new IPAddress(destination), IP_PROTO_ICMP, 64, icmp, 8 + 32, { ipOptions });
}

async function crossLer(ipOptions: IPv4Option[]) {
  const { ce1, r1, r2 } = await lab();
  const seen: number[][] = [];
  const engine = r2.getMplsEngine();
  const original = engine.receive.bind(engine);
  engine.receive = (inPort, packet) => { seen.push(packet.stack.map(entry => entry.label.value)); original(inPort, packet); };
  const imposed = r1.getMplsEngine().counters.imposed;
  const inbound = r1.getPort('GigabitEthernet0/0')!;
  inbound.receiveFrame({
    srcMAC: ce1.getPort('eth0')!.getMAC(), dstMAC: inbound.getMAC(), etherType: ETHERTYPE_IPV4,
    payload: optionPacket('192.168.1.10', '192.168.2.10', ipOptions),
  });
  return { seen, imposedDelta: r1.getMplsEngine().counters.imposed - imposed };
}

const OPTIONS: Array<[string, IPv4Option[]]> = [
  ['Router Alert (148)', [{ type: 148, data: [0, 0] }]],
  ['Record Route (7)', [buildRecordRouteOption(3)]],
  ['no option', []],
];

describe('ingress LER policy for IPv4 option packets (RFC 6178 §4)', () => {
  it.each(OPTIONS)('a packet with %s is labelled at the ingress and reaches the transit LSR as an MPLS packet', async (_name, options) => {
    const { seen, imposedDelta } = await crossLer(options);
    expect(imposedDelta).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('the Router Alert option does not make the ingress push the Router Alert label (§4)', async () => {
    const { seen } = await crossLer([{ type: 148, data: [0, 0] }]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).not.toContain(1);
  });
});
