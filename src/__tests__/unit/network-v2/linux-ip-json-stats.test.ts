import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeIpCommand,
  type IpNetworkContext,
  type IpInterfaceInfo,
  type IpRouteEntry,
  type IpNeighborEntry,
} from '@/network/devices/linux/LinuxIpCommand';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

function createMockContext(overrides: Partial<IpNetworkContext> = {}): IpNetworkContext {
  const interfaces: Map<string, IpInterfaceInfo> = new Map([
    ['lo', {
      name: 'lo', mac: '00:00:00:00:00:00',
      ip: '127.0.0.1', mask: '255.0.0.0', cidr: 8,
      mtu: 65536, isUp: true, isConnected: true, isDHCP: false,
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
    ['eth0', {
      name: 'eth0', mac: 'aa:bb:cc:dd:ee:01',
      ip: '192.168.1.10', mask: '255.255.255.0', cidr: 24,
      mtu: 1500, isUp: true, isConnected: true, isDHCP: false,
      counters: { framesIn: 100, framesOut: 50, bytesIn: 10240, bytesOut: 5120, errorsIn: 2, errorsOut: 0 },
    }],
  ]);

  const routes: IpRouteEntry[] = [
    { network: '192.168.1.0', cidr: 24, nextHop: null, iface: 'eth0', type: 'connected', metric: 0, isDHCP: false, srcIp: '192.168.1.10' },
  ];
  const neighbors: IpNeighborEntry[] = [
    { ip: '192.168.1.1', mac: 'aa:bb:cc:00:00:01', iface: 'eth0', state: 'REACHABLE' },
  ];

  return {
    getInterfaceNames: () => [...interfaces.keys()],
    getInterfaceInfo: (name: string) => interfaces.get(name) || null,
    configureInterface: () => '',
    removeInterfaceIP: () => '',
    getRoutingTable: () => routes,
    addDefaultRoute: () => '',
    addStaticRoute: () => '',
    deleteDefaultRoute: () => '',
    deleteRoute: () => '',
    getNeighborTable: () => neighbors,
    addNeighbor: () => '',
    deleteNeighbor: () => '',
    flushNeighbors: () => '',
    setInterfaceUp: () => '',
    setInterfaceDown: () => '',
    ...overrides,
  };
}

describe('ip -j/-p JSON output and -s statistics (PRD-ip.md P1)', () => {
  let ctx: IpNetworkContext;
  beforeEach(() => { ctx = createMockContext(); });

  it('ip -j addr show produces a valid JSON array with real interface data', () => {
    const output = executeIpCommand(ctx, ['-j', 'addr', 'show', 'dev', 'eth0']);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].ifname).toBe('eth0');
    expect(parsed[0].address).toBe('aa:bb:cc:dd:ee:01');
    expect(parsed[0].addr_info[0].local).toBe('192.168.1.10');
    expect(parsed[0].addr_info[0].prefixlen).toBe(24);
  });

  it('ip -j link show produces valid JSON with flags array', () => {
    const output = executeIpCommand(ctx, ['-j', 'link', 'show', 'dev', 'eth0']);
    const parsed = JSON.parse(output);
    expect(parsed[0].flags).toContain('BROADCAST');
    expect(parsed[0].flags).toContain('UP');
    expect(parsed[0].mtu).toBe(1500);
  });

  it('ip -j route show produces valid JSON matching real ip -j schema keys', () => {
    const output = executeIpCommand(ctx, ['-j', 'route', 'show']);
    const parsed = JSON.parse(output);
    expect(parsed[0].dst).toBe('192.168.1.0/24');
    expect(parsed[0].dev).toBe('eth0');
    expect(parsed[0].protocol).toBe('kernel');
    expect(parsed[0].prefsrc).toBe('192.168.1.10');
  });

  it('ip -j neigh show produces valid JSON', () => {
    const output = executeIpCommand(ctx, ['-j', 'neigh', 'show']);
    const parsed = JSON.parse(output);
    expect(parsed[0].dst).toBe('192.168.1.1');
    expect(parsed[0].lladdr).toBe('aa:bb:cc:00:00:01');
    expect(parsed[0].state).toEqual(['REACHABLE']);
  });

  it('ip -j -p addr show pretty-prints the JSON with indentation', () => {
    const output = executeIpCommand(ctx, ['-j', '-p', 'addr', 'show', 'dev', 'eth0']);
    expect(output).toContain('\n');
    expect(JSON.parse(output)).toBeTruthy();
  });

  it('ip -j (without -p) emits compact single-line JSON', () => {
    const output = executeIpCommand(ctx, ['-j', 'addr', 'show', 'dev', 'eth0']);
    expect(output.split('\n').length).toBe(1);
  });

  it('ip -s link show renders real RX/TX byte and packet counters', () => {
    const output = executeIpCommand(ctx, ['-s', 'link', 'show', 'dev', 'eth0']);
    expect(output).toContain('RX:');
    expect(output).toContain('TX:');
    expect(output).toContain('10240');
    expect(output).toContain('5120');
  });

  it('ip -j -s link show includes stats64 with real counters', () => {
    const output = executeIpCommand(ctx, ['-j', '-s', 'link', 'show', 'dev', 'eth0']);
    const parsed = JSON.parse(output);
    expect(parsed[0].stats64.rx.bytes).toBe(10240);
    expect(parsed[0].stats64.rx.packets).toBe(100);
    expect(parsed[0].stats64.rx.errors).toBe(2);
    expect(parsed[0].stats64.tx.bytes).toBe(5120);
  });

  it('ip -s addr show also renders RX/TX counters (not just ip -s link)', () => {
    const output = executeIpCommand(ctx, ['-s', 'addr', 'show', 'dev', 'eth0']);
    expect(output).toContain('RX:');
    expect(output).toContain('10240');
  });
});

describe('ip -j/-s through a real LinuxPC (integration, PRD-ip.md P1)', () => {
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  it('real traffic between two PCs shows up as nonzero RX/TX counters via ip -s link show', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 100, 0);
    const sw = new CiscoSwitch('sw-json-stats', 'SW1', 24, 50, 50);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    await pc1.executeCommand('ping -c 2 10.0.0.2');

    const output = await pc1.executeCommand('ip -s link show eth0');
    const rxLine = output.split('\n')[3].trim().split(/\s+/);
    expect(Number(rxLine[0])).toBeGreaterThan(0);

    const jsonOutput = await pc1.executeCommand('ip -j -s link show eth0');
    const parsed = JSON.parse(jsonOutput);
    expect(parsed[0].stats64.rx.bytes).toBeGreaterThan(0);
    expect(parsed[0].stats64.tx.bytes).toBeGreaterThan(0);
  });

  it('ip -j addr show through a real LinuxPC produces valid, parseable JSON', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    const output = await pc1.executeCommand('ip -j addr show');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    const eth0 = parsed.find((e: { ifname: string }) => e.ifname === 'eth0');
    expect(eth0.addr_info[0].local).toBe('10.0.0.1');
  });
});
