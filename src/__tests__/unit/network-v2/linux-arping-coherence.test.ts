import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('arping is coherent with the ARP table', () => {
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

  it('reachable host returns N/N responses and shows the MAC', async () => {
    const out = await pc.executeCommand('arping -c 2 10.0.0.2');
    expect(out).toMatch(/ARPING 10\.0\.0\.2/);
    expect(out).toMatch(/Received 2 response/);
    expect(out).toMatch(/Sent 2 prob/);
    expect(out).toMatch(/from 10\.0\.0\.2 \[[0-9a-fA-F:]{17}\]/);
  });

  it('unreachable target returns 0 responses', async () => {
    const out = await pc.executeCommand('arping -c 2 10.0.0.99');
    expect(out).toMatch(/Sent 2 prob/);
    expect(out).toMatch(/Received 0 response/);
  });

  it('default count is 1 when -c is omitted', async () => {
    const out = await pc.executeCommand('arping 10.0.0.2');
    expect(out).toMatch(/Sent 1 prob/);
    expect(out).toMatch(/Received 1 response/);
  });

  it('exits 0 on at least one reply, 1 otherwise', async () => {
    const okEc = await pc.executeCommand('arping -c 1 10.0.0.2; echo EC=$?');
    expect(okEc).toMatch(/EC=0/);
    const failEc = await pc.executeCommand('arping -c 1 10.0.0.99; echo EC=$?');
    expect(failEc).toMatch(/EC=1/);
  });
});
