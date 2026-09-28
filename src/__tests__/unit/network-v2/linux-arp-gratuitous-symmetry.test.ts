import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Linux learns a neighbour from traffic, not from its announcement (arp_accept=0)', () => {
  let pc1: LinuxPC;
  let srv1: LinuxServer;
  let win: WindowsPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
    srv1 = new LinuxServer('linux-server', 'Server1', 0, 0);
    win = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc1, srv1, win, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv1.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    new Cable('c3').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  });

  async function addressAll(): Promise<void> {
    await pc1.executeCommand('ifconfig eth0 192.168.1.1');
    await srv1.executeCommand('ifconfig eth0 192.168.1.11');
    await win.executeCommand('netsh interface ip set address eth0 static 192.168.1.2 255.255.255.0');
  }

  it('after ifconfig alone, a Linux host has learned no neighbour', async () => {
    await addressAll();

    expect(await pc1.executeCommand('arp -n')).not.toMatch(/^192\.168\.1\./m);
    expect(await srv1.executeCommand('arp -n')).not.toMatch(/^192\.168\.1\./m);
  });

  it('after a ping, both ends know each other', async () => {
    await addressAll();
    await pc1.executeCommand('ping -c 1 192.168.1.11');

    expect(await pc1.executeCommand('arp -n')).toMatch(/^192\.168\.1\.11\s/m);
    expect(await srv1.executeCommand('arp -n')).toMatch(/^192\.168\.1\.1\s/m);
  });

  it('arp -n stays stable across re-invocations', async () => {
    await addressAll();
    await pc1.executeCommand('ping -c 1 192.168.1.11');
    const first = await srv1.executeCommand('arp -n');
    const second = await srv1.executeCommand('arp -n');
    expect(second).toBe(first);
  });

  it('arp and ip neigh report the same MAC for the same IP', async () => {
    await addressAll();
    await pc1.executeCommand('ping -c 1 192.168.1.11');
    const arpRow = (await srv1.executeCommand('arp -n')).split('\n').find((l) => l.startsWith('192.168.1.1 ')) ?? '';
    const neighRow = (await srv1.executeCommand('ip neigh')).split('\n').find((l) => l.startsWith('192.168.1.1 ')) ?? '';
    const macFrom = (s: string) => s.match(/([0-9a-fA-F:]{17})/)?.[1].toLowerCase() ?? '';
    expect(macFrom(arpRow)).toBe(macFrom(neighRow));
    expect(macFrom(arpRow)).toMatch(/^[0-9a-f:]{17}$/);
  });

  it('the order of ifconfig does not change what a ping teaches', async () => {
    await win.executeCommand('netsh interface ip set address eth0 static 192.168.1.2 255.255.255.0');
    await srv1.executeCommand('ifconfig eth0 192.168.1.11');
    await pc1.executeCommand('ifconfig eth0 192.168.1.1');
    await pc1.executeCommand('ping -c 1 192.168.1.11');

    expect(await pc1.executeCommand('arp -n')).toMatch(/^192\.168\.1\.11\s/m);
    expect(await srv1.executeCommand('arp -n')).toMatch(/^192\.168\.1\.1\s/m);
  });
});
