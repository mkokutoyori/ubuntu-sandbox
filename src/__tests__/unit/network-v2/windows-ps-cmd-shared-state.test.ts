import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('Resolve-DnsName — resolves over the real wire, not a hardcoded address', () => {
  it('resolves a hosts-file entry to its real address, not 192.168.1.1', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('echo 10.5.5.5 realhost.local >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    const shell = ps(pc);
    const out = await run(shell, 'Resolve-DnsName realhost.local');
    expect(out).toContain('10.5.5.5');
    expect(out).not.toContain('192.168.1.1');
  });
});

describe('Get-NetTCPConnection — reflects the real socket table, not fabricated ports', () => {
  it('shows a listening socket that netstat also reports', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);
    const psOut = await run(shell, 'Get-NetTCPConnection');
    const cmdOut = await pc.executeCommand('netstat -ano');
    const psPorts = [...psOut.matchAll(/^\S+\s+(\d+)\s/gm)].map(m => m[1]);
    for (const port of psPorts) {
      if (port === '0') continue;
      expect(cmdOut).toContain(port);
    }
  });
});

describe('Clear-DnsClientCache / Get-DnsClientCache — operate on the real dnsCache', () => {
  it('flushes the same cache ipconfig /displaydns reads', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    await pc.executeCommand('echo 10.9.9.9 cached.local >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    await pc.executeCommand('ping -n 1 cached.local');
    const shell = ps(pc);
    await run(shell, 'Clear-DnsClientCache');
    const out = await pc.executeCommand('ipconfig /displaydns');
    expect(out).not.toContain('cached.local');
  });
});

describe('Get-NetNeighbor / Remove-NetNeighbor — share arpTable with arp', () => {
  it('an entry added via "arp -s" (cmd) is visible to Get-NetNeighbor (PS)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.2.5'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('arp -s 10.0.2.50 00-11-22-33-44-55');

    const shell = ps(pc);
    const out = await run(shell, 'Get-NetNeighbor -IPAddress 10.0.2.50');
    expect(out).toContain('10.0.2.50');

    await run(shell, 'Remove-NetNeighbor -IPAddress 10.0.2.50 -Confirm:$false');
    const cmdOut = await pc.executeCommand('arp -a');
    expect(cmdOut).not.toContain('10.0.2.50');
  });
});

describe('netsh winhttp — real, shared proxy state (not a no-op stub)', () => {
  it('a proxy set via PS is reported by "show proxy" in cmd, and vice versa', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);

    await run(shell, 'netsh winhttp set proxy 10.0.0.9:8080');
    const cmdShow = await pc.executeCommand('netsh winhttp show proxy');
    expect(cmdShow).toContain('10.0.0.9:8080');

    await pc.executeCommand('netsh winhttp reset proxy');
    const psShow = await run(shell, 'netsh winhttp show proxy');
    expect(psShow).toContain('Direct access');
    expect(psShow).not.toContain('10.0.0.9:8080');
  });
});
