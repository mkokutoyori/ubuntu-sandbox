import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

export async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) out.push(await router.executeCommand(line));
  return out;
}

export const IKE = ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit'];
export const TSET = ['crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit'];

export interface EzvpnClientLab { hub: CiscoRouter; client: CiscoRouter; pc: LinuxPC; esp: { count: number } }

export async function ezvpnClientLab(hubExtra: string[] = [], groupLines: string[] = ['key GROUPKEY', 'pool VPNPOOL']): Promise<EzvpnClientLab> {
  const hub = new CiscoRouter('HUB');
  const client = new CiscoRouter('CLIENT');
  const pc = new LinuxPC('linux-pc', 'PC1');
  new Cable('wan').connect(hub.getPort('GigabitEthernet0/1')!, client.getPort('GigabitEthernet0/1')!);
  new Cable('lan').connect(pc.getPort('eth0')!, client.getPort('GigabitEthernet0/0')!);
  await run(hub, [
    'interface Loopback0', 'ip address 10.1.0.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
    ...IKE, 'crypto isakmp key WILDKEY address 0.0.0.0 0.0.0.0', ...TSET,
    'crypto dynamic-map DMAP 10', 'set transform-set TSET', 'exit',
    'crypto map CMAP 65535 ipsec-isakmp dynamic DMAP',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    'aaa new-model', 'aaa authentication login XAUTH local', 'username alice secret alicepw',
    'ip local pool VPNPOOL 10.9.9.1 10.9.9.9',
    'access-list 150 permit ip 10.1.0.0 0.0.0.255 any',
    'crypto isakmp client configuration group VPNGROUP', ...groupLines, 'exit',
    'crypto map CMAP client configuration address respond',
    'ip route 192.168.10.0 255.255.255.0 10.0.12.2', 'ip route 10.9.9.0 255.255.255.0 10.0.12.2',
    ...hubExtra,
  ]);
  await run(client, [
    'interface GigabitEthernet0/1', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    ...IKE,
    'ip route 10.1.0.0 255.255.255.0 10.0.12.1',
  ]);
  await pc.executeCommand('sudo ip addr add 192.168.10.10/24 dev eth0');
  await pc.executeCommand('sudo ip route add default via 192.168.10.1');
  const esp = { count: 0 };
  client.getPort('GigabitEthernet0/1')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    const packet = frame.payload as IPv4Packet | undefined;
    if (direction === 'out' && packet?.type === 'ipv4' && packet.protocol === 50) esp.count++;
  });
  return { hub, client, pc, esp };
}


export const configureClient = (lines: string[] = []): string[] => [
  'crypto ipsec client ezvpn EZ', 'group VPNGROUP key GROUPKEY', 'peer 10.0.12.1', ...lines, 'exit',
];

export const assignInterfaces = ['interface GigabitEthernet0/1', 'crypto ipsec client ezvpn EZ outside', 'exit',
  'interface GigabitEthernet0/0', 'crypto ipsec client ezvpn EZ inside', 'exit'];
