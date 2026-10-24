import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { sudo } from './natGateway';

export const STICK_A_IP = '10.0.0.2';
export const STICK_B_IP = '10.0.1.2';
export const STICK_GATEWAY_A_SIDE_IP = '10.0.0.1';
export const STICK_GATEWAY_B_SIDE_IP = '10.0.1.1';
export const STICK_ROUTER_IP = '10.0.0.254';
export const BEHIND_IP = '10.0.2.2';
export const BEHIND_ROUTER_IP = '10.0.2.1';

const MASK = new SubnetMask('255.255.255.0');

export interface StickLab {
  readonly a: LinuxPC;
  readonly b: LinuxServer;
  readonly gateway: LinuxServer;
  readonly hub: Hub;
}

export async function routerOnAStick(primary: 'a' | 'b' = 'a'): Promise<StickLab> {
  const a = new LinuxPC('linux-pc', 'A');
  const b = new LinuxServer('linux-server', 'B');
  const gateway = new LinuxServer('linux-server', 'GW');
  const hub = new Hub('HUB', 6);
  a.configureInterface('eth0', new IPAddress(STICK_A_IP), MASK);
  b.configureInterface('eth0', new IPAddress(STICK_B_IP), MASK);
  const [first, second] = primary === 'a'
    ? [STICK_GATEWAY_A_SIDE_IP, STICK_GATEWAY_B_SIDE_IP]
    : [STICK_GATEWAY_B_SIDE_IP, STICK_GATEWAY_A_SIDE_IP];
  gateway.configureInterface('eth0', new IPAddress(first), MASK);
  await sudo(gateway, `ip addr add ${second}/24 dev eth0`);
  a.setDefaultGateway(new IPAddress(STICK_GATEWAY_A_SIDE_IP));
  b.setDefaultGateway(new IPAddress(STICK_GATEWAY_B_SIDE_IP));
  new Cable('a').connect(a.getPort('eth0')!, hub.getPort('eth0')!);
  new Cable('b').connect(b.getPort('eth0')!, hub.getPort('eth1')!);
  new Cable('gateway').connect(gateway.getPort('eth0')!, hub.getPort('eth2')!);
  await sudo(gateway, 'sysctl -w net.ipv4.ip_forward=1');
  return { a, b, gateway, hub };
}

export interface BehindRouterLab extends StickLab {
  readonly router: LinuxServer;
  readonly behind: LinuxPC;
}

export async function stickWithRouterBehind(routerAddress: string = STICK_ROUTER_IP): Promise<BehindRouterLab> {
  const onASide = routerAddress.startsWith('10.0.0.');
  const lab = await routerOnAStick(onASide ? 'a' : 'b');
  const router = new LinuxServer('linux-server', 'R');
  const behind = new LinuxPC('linux-pc', 'S');
  router.configureInterface('eth0', new IPAddress(routerAddress), MASK);
  router.configureInterface('eth1', new IPAddress(BEHIND_ROUTER_IP), MASK);
  behind.configureInterface('eth0', new IPAddress(BEHIND_IP), MASK);
  behind.setDefaultGateway(new IPAddress(BEHIND_ROUTER_IP));
  new Cable('router').connect(router.getPort('eth0')!, lab.hub.getPort('eth3')!);
  const behindHub = new Hub('BEHIND-HUB', 2);
  new Cable('router-behind').connect(router.getPort('eth1')!, behindHub.getPort('eth0')!);
  new Cable('behind').connect(behind.getPort('eth0')!, behindHub.getPort('eth1')!);
  await sudo(router, 'sysctl -w net.ipv4.ip_forward=1');
  await sudo(router, `ip route add ${onASide ? '10.0.1.0/24' : '10.0.0.0/24'} via ${onASide ? STICK_GATEWAY_A_SIDE_IP : STICK_GATEWAY_B_SIDE_IP}`);
  await sudo(lab.gateway, `ip route add 10.0.2.0/24 via ${routerAddress}`);
  return { ...lab, router, behind };
}
