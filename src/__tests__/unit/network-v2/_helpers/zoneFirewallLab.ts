import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';

export interface ZoneLab {
  fw: CiscoRouter;
  inside: LinuxPC;
  outside: LinuxPC;
  seenByOutside: { count: number };
  seenByInside: { count: number };
}

function countIcmpRequests(pc: LinuxPC): { count: number } {
  const seen = { count: 0 };
  pc.getPort('eth0')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const icmp = packet?.type === 'ipv4' ? packet.payload as { type?: string; icmpType?: string | number } : undefined;
    if (icmp?.type === 'icmp' && (icmp.icmpType === 'echo-request' || icmp.icmpType === 8)) seen.count++;
  });
  return seen;
}

export async function zoneLab(config: string[] = []): Promise<ZoneLab> {
  const fw = new CiscoRouter('FW');
  const inside = new LinuxPC('linux-pc', 'INSIDE');
  const outside = new LinuxPC('linux-pc', 'OUTSIDE');
  new Cable('in').connect(inside.getPort('eth0')!, fw.getPort('GigabitEthernet0/0')!);
  new Cable('out').connect(outside.getPort('eth0')!, fw.getPort('GigabitEthernet0/1')!);
  for (const line of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...config, 'end',
  ]) await fw.executeCommand(line);
  await inside.executeCommand('sudo ip addr add 10.0.1.10/24 dev eth0');
  await inside.executeCommand('sudo ip route add default via 10.0.1.1');
  await outside.executeCommand('sudo ip addr add 10.0.2.10/24 dev eth0');
  await outside.executeCommand('sudo ip route add default via 10.0.2.1');
  return { fw, inside, outside, seenByOutside: countIcmpRequests(outside), seenByInside: countIcmpRequests(inside) };
}

export const ZONES = [
  'zone security INSIDE', 'exit', 'zone security OUTSIDE', 'exit',
  'interface GigabitEthernet0/0', 'zone-member security INSIDE', 'exit',
  'interface GigabitEthernet0/1', 'zone-member security OUTSIDE', 'exit',
];

export function inspectPolicy(protocol: string, action: string): string[] {
  return [
    'class-map type inspect match-any C1', `match protocol ${protocol}`, 'exit',
    'policy-map type inspect P1', 'class type inspect C1', action, 'exit',
    'class class-default', 'drop log', 'exit', 'exit',
  ];
}

export const PAIR_IN_OUT = [
  'zone-pair security IN-OUT source INSIDE destination OUTSIDE', 'service-policy type inspect P1', 'exit',
];
