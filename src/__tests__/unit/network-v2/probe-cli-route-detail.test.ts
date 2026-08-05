import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routerWithRoutes(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  const pc = new LinuxPC('PC1');
  new Cable(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);

  for (const command of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.0.0.0 192.168.10.2',
    'ip route 172.16.0.0 255.255.0.0 192.168.10.9 200',
    'end',
  ]) await r.executeCommand(command);
  return r;
}

describe('show ip route <address> renders the IOS detail block', () => {
  it('a connected route carries its Routing Descriptor Blocks', async () => {
    const r = await routerWithRoutes();
    const out = await r.executeCommand('show ip route 192.168.10.5');

    expect(out).toContain('Routing entry for 192.168.10.0/24');
    expect(out).toContain('Known via "connected"');
    expect(out).toContain('Routing Descriptor Blocks:');
    expect(out).toMatch(/^ {2}\* directly connected, via GigabitEthernet0\/0$/m);
    expect(out).toMatch(/^ {6}Route metric is 0, traffic share count is 1$/m);
  });

  it('a static route names its next hop in the descriptor block', async () => {
    const r = await routerWithRoutes();
    const out = await r.executeCommand('show ip route 10.1.2.3');

    expect(out).toContain('Routing entry for 10.0.0.0/8');
    expect(out).toContain('Known via "static", distance 1, metric 0');
    expect(out).toContain('Routing Descriptor Blocks:');
    expect(out).toMatch(/^ {2}\* 192\.168\.10\.2/m);
  });

  it('a floating static reports the distance it was configured with', async () => {
    const r = await routerWithRoutes();
    const out = await r.executeCommand('show ip route 172.16.5.5');

    expect(out).toContain('distance 200');
    expect(out).not.toContain('distance 1,');
  });

  it('it never renders a routing-table line, which IOS does not show here', async () => {
    const r = await routerWithRoutes();
    for (const target of ['192.168.10.5', '10.1.2.3']) {
      const out = await r.executeCommand(`show ip route ${target}`);
      expect(out).not.toMatch(/^[CSOLRDB]\*?\s+\d/m);
      expect(out).not.toContain('Connected via');
    }
  });

  it('an unknown destination is reported absent', async () => {
    const r = await routerWithRoutes();
    expect(await r.executeCommand('show ip route 203.0.113.7'))
      .toContain('% Network not in table');
  });

  it('a RIP route is found, not reported absent', async () => {
    const r = new CiscoRouter('R1');
    for (const command of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0',
      'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
      'end',
    ]) await r.executeCommand(command);

    (r as unknown as { routingTable: unknown[] }).routingTable.push({
      network: { toString: () => '10.0.0.0', toUint32: () => 0x0a000000 },
      mask: { toString: () => '255.0.0.0', toCIDR: () => 8 },
      type: 'rip', nextHop: '192.168.10.2', iface: 'GigabitEthernet0/0',
      ad: 120, metric: 3,
    });

    const out = await r.executeCommand('show ip route 10.1.1.1');
    expect(out).not.toContain('% Network not in table');
    expect(out).toContain('Known via "rip", distance 120, metric 3');
    expect(out).toContain('Routing Descriptor Blocks:');
  });
});
