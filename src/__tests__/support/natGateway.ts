import { expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { pingOnSimulatedClock } from './fastPing';

export const INSIDE_IP = '10.0.0.2';
export const NEIGHBOUR_IP = '10.0.0.3';
export const GATEWAY_INSIDE_IP = '10.0.0.1';
export const GATEWAY_OUTSIDE_IP = '203.0.113.1';
export const OUTSIDE_IP = '203.0.113.2';
export const ROUTER_GATEWAY_SIDE_IP = '203.0.113.254';
export const ROUTER_FAR_SIDE_IP = '198.51.100.254';
export const FAR_IP = '198.51.100.2';

const MASK = new SubnetMask('255.255.255.0');

export interface InsideSegment {
  readonly inside: LinuxServer;
  readonly neighbour: LinuxPC;
  readonly gateway: LinuxServer;
}

export interface NatGateway extends InsideSegment {
  readonly outside: LinuxServer;
}

export interface NatPath extends InsideSegment {
  readonly router: LinuxServer;
  readonly far: LinuxServer;
}

async function insideSegment(): Promise<InsideSegment> {
  const inside = new LinuxServer('linux-server', 'IN');
  const neighbour = new LinuxPC('linux-pc', 'NEIGHBOUR');
  const gateway = new LinuxServer('linux-server', 'GW');
  const hub = new Hub('HUB', 4);
  inside.configureInterface('eth0', new IPAddress(INSIDE_IP), MASK);
  neighbour.configureInterface('eth0', new IPAddress(NEIGHBOUR_IP), MASK);
  gateway.configureInterface('eth0', new IPAddress(GATEWAY_INSIDE_IP), MASK);
  gateway.configureInterface('eth1', new IPAddress(GATEWAY_OUTSIDE_IP), MASK);
  inside.setDefaultGateway(new IPAddress(GATEWAY_INSIDE_IP));
  neighbour.setDefaultGateway(new IPAddress(GATEWAY_INSIDE_IP));
  new Cable('gateway-inside').connect(gateway.getPort('eth0')!, hub.getPort('eth0')!);
  new Cable('inside').connect(inside.getPort('eth0')!, hub.getPort('eth1')!);
  new Cable('neighbour').connect(neighbour.getPort('eth0')!, hub.getPort('eth2')!);
  await gateway.executeCommand('sysctl -w net.ipv4.ip_forward=1');
  return { inside, neighbour, gateway };
}

export async function natGateway(): Promise<NatGateway> {
  const segment = await insideSegment();
  const outside = new LinuxServer('linux-server', 'OUT');
  outside.configureInterface('eth0', new IPAddress(OUTSIDE_IP), MASK);
  outside.setDefaultGateway(new IPAddress(GATEWAY_OUTSIDE_IP));
  new Cable('outside').connect(segment.gateway.getPort('eth1')!, outside.getPort('eth0')!);
  return { ...segment, outside };
}

export async function natPath(): Promise<NatPath> {
  const segment = await insideSegment();
  const router = new LinuxServer('linux-server', 'ROUTER');
  const far = new LinuxServer('linux-server', 'FAR');
  router.configureInterface('eth0', new IPAddress(ROUTER_GATEWAY_SIDE_IP), MASK);
  router.configureInterface('eth1', new IPAddress(ROUTER_FAR_SIDE_IP), MASK);
  far.configureInterface('eth0', new IPAddress(FAR_IP), MASK);
  far.setDefaultGateway(new IPAddress(ROUTER_FAR_SIDE_IP));
  segment.gateway.setDefaultGateway(new IPAddress(ROUTER_GATEWAY_SIDE_IP));
  new Cable('gateway-router').connect(segment.gateway.getPort('eth1')!, router.getPort('eth0')!);
  new Cable('router-far').connect(router.getPort('eth1')!, far.getPort('eth0')!);
  await router.executeCommand('sysctl -w net.ipv4.ip_forward=1');
  return { ...segment, router, far };
}

export type Host = Parameters<typeof pingOnSimulatedClock>[0];

export const sudo = async (host: Host, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);

export async function nat(host: Host, ...rules: string[]): Promise<void> {
  for (const rule of rules) expect(await sudo(host, `iptables -t nat ${rule}`)).toBe('');
}

export const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function watchSources(host: Host, protocol: string, ...sources: string[]): Promise<() => Promise<Record<string, number>>> {
  for (const source of sources) await sudo(host, `iptables -A INPUT -s ${source} -p ${protocol} -j ACCEPT`);
  return async () => {
    const listing = await sudo(host, 'iptables -L INPUT -v -n');
    return Object.fromEntries(sources.map((source) => {
      const row = listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+ACCEPT\\s+\\S+\\s+--\\s+\\*\\s+\\*\\s+${escaped(source)}\\s`).test(line)) ?? '';
      return [source, Number(row.trim().split(/\s+/)[0])];
    }));
  };
}

export async function flows(host: Host, ...filter: string[]): Promise<string[]> {
  const listing = await sudo(host, `conntrack -L ${filter.join(' ')}`);
  return listing.split('\n').filter((line) => /^(tcp|udp|icmp)\s/.test(line));
}

export const connect = (host: Host, target: string, port: number): Promise<string> => pingOnSimulatedClock(host, `nc -zv -w 2 ${target} ${port}`);
export const fetchPage = (host: Host, url: string): Promise<string> => pingOnSimulatedClock(host, `curl -s -m 3 ${url}`);
