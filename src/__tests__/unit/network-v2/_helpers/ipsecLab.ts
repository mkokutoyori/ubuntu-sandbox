import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';

export interface IpsecLab {
  r1: CiscoRouter;
  r2: CiscoRouter;
  pc1: LinuxPC;
  pc2: LinuxPC;
  wire: IPv4Packet[];
}

async function run(device: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

function site(local: string, peer: string, lan: string, remoteLan: string, localLan: string, remoteNet: string, remoteGw: string): string[] {
  return [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${local} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lan} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    `crypto isakmp key VpnSecret!1 address ${peer}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_TRAFFIC', `permit ip ${localLan} 0.0.0.255 ${remoteLan} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`, 'set transform-set TSET', 'match address VPN_TRAFFIC', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    `ip route ${remoteNet} 255.255.255.0 ${remoteGw}`,
    'end',
  ];
}

export async function ipsecLab(extraR1: string[] = []): Promise<IpsecLab> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  await run(r1, site('10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.2.0', '192.168.1.0', '192.168.2.0', '10.0.12.2'));
  await run(r2, site('10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.1.0', '192.168.2.0', '192.168.1.0', '10.0.12.1'));
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
  await run(r1, ['enable', 'configure terminal', ...extraR1, 'end']);
  const wire: IPv4Packet[] = [];
  r1.getPort('GigabitEthernet0/1')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'out') return;
    const packet = frame.payload as IPv4Packet | undefined;
    if (packet?.type === 'ipv4' && packet.protocol === 50) wire.push(packet);
  });
  return { r1, r2, pc1, pc2, wire };
}
