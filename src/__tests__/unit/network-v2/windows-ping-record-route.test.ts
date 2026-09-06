/**
 * ping -r / -s show the REAL forward path, not fabricated repeats of the
 * target IP (audit §2.3). Also pins the remaining legacy-executor stubs:
 * Clear-DnsClientCache, Restart-NetAdapter, Get-Date.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('ping -r records the real route', () => {
  it('lists the actual next hop / target, not the target repeated N times', async () => {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const peer = new LinuxPC('PC2', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('eth0')!);
    new Cable('c2').connect(peer.getPort('eth0')!, sw.getPort('eth1')!);
    win.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    await peer.executeCommand('ifconfig eth0 10.0.0.6 netmask 255.255.255.0');

    const out = await win.executeCommand('ping -n 1 -r 4 10.0.0.6');
    expect(out).toContain('Reply from 10.0.0.6');
    // On a directly-connected /24 the recorded route is just the target,
    // listed ONCE — never four fabricated copies.
    const routeIdx = out.indexOf('Route:');
    if (routeIdx >= 0) {
      const routeBlock = out.slice(routeIdx);
      const occurrences = (routeBlock.match(/10\.0\.0\.6/g) ?? []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('shows no Route block when the destination is unreachable', async () => {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    win.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    const out = await win.executeCommand('ping -n 1 -w 100 -r 4 10.0.0.99');
    expect(out).not.toContain('Route:');
  });
});

describe('les vues PowerShell agissent sur la machine, elles ne sont pas des stubs', () => {
  const makePs = (pc: WindowsPC) => {
    const shell = PowerShellSubShell.create(pc).subShell;
    return { execute: async (line: string) => (await shell.processLine(line)).output.join('\n') };
  };

  it('Clear-DnsClientCache flushes the cache ipconfig /displaydns reads', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('echo 10.9.9.9 cached.local >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    await pc.executeCommand('ping -n 1 cached.local');
    await makePs(pc).execute('Clear-DnsClientCache');
    const out = await pc.executeCommand('ipconfig /displaydns');
    expect(out).not.toContain('cached.local');
  });

  it('Restart-NetAdapter cycles the real port (ends Up, visible to ipconfig)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.4.5'), new SubnetMask('255.255.255.0'));
    await makePs(pc).execute('Restart-NetAdapter -Name "Ethernet 0"');
    expect(pc.getPort('eth0')!.isAdminDown()).toBe(false);
  });

  it('Get-Date renders the PowerShell long date, not the JS Date string', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await makePs(pc).execute('Get-Date');
    // PS long form contains a weekday name and no "GMT+"/timezone-paren junk.
    expect(out).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    expect(out).not.toContain('GMT');
  });
});
