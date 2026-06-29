import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Unreachable ARP target leaves a FAILED neigh entry', () => {
  let pc: LinuxPC;
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');
    await srv.executeCommand('ifconfig eth0 10.0.0.2');
  });

  it('ip neigh shows the unreachable target as FAILED', async () => {
    await pc.executeCommand('ping -c 1 -W 1 10.0.0.99');
    const neigh = await pc.executeCommand('ip neigh');
    expect(neigh).toMatch(/^10\.0\.0\.99 .* FAILED$/m);
  });

  it('arp -n omits FAILED entries (real net-tools)', async () => {
    await pc.executeCommand('ping -c 1 -W 1 10.0.0.99');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).not.toMatch(/^10\.0\.0\.99\b/m);
  });

  it('/proc/net/arp omits FAILED entries (real kernel)', async () => {
    await pc.executeCommand('ping -c 1 -W 1 10.0.0.99');
    const proc = await pc.executeCommand('cat /proc/net/arp');
    expect(proc).not.toMatch(/^10\.0\.0\.99\b/m);
  });

  it('a later successful ping clears the FAILED entry', async () => {
    await pc.executeCommand('ping -c 1 -W 1 10.0.0.99');
    expect(await pc.executeCommand('ip neigh')).toMatch(/FAILED/);
    await srv.executeCommand('ifconfig eth0 10.0.0.99');
    await pc.executeCommand('ping -c 1 10.0.0.99');
    const neigh = await pc.executeCommand('ip neigh');
    expect(neigh).toMatch(/^10\.0\.0\.99 .* REACHABLE/m);
    expect(neigh).not.toMatch(/^10\.0\.0\.99 .* FAILED/m);
  });
});
