/**
 * Coherence cmd / PowerShell — une machine, un seul etat.
 *
 * Quel que soit le chemin qui sert une cmdlet, elle lit et ecrit le MEME
 * etat que les commandes cmd (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §1).
 * Tous les cas pilotent le moteur que la machine sert reellement ; le
 * moteur historique a ete supprime.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

const makePc = (): WindowsPC => new WindowsPC('windows-pc', 'PC1', 0, 0);
const makeLivePs = (pc: WindowsPC): { execute(l: string): Promise<string> } => {
  const sh = PowerShellSubShell.create(pc).subShell;
  return { execute: async (l: string) => (await sh.processLine(l)).output.join('\n') };
};

// ═══════════════════════════════════════════════════════════════════
// Get-NetIPAddress — reads real port state, never invents addresses
// ═══════════════════════════════════════════════════════════════════

describe('Get-NetIPAddress reflects real interface state', () => {
  it('does not fabricate a 192.168.1.10x address for an unconfigured adapter', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).not.toMatch(/192\.168\.1\.10\d/);
  });

  it('shows the address actually configured on the port', async () => {
    const pc = makePc();
    pc.configureInterface('eth0', new IPAddress('10.0.1.5'), new SubnetMask('255.255.255.0'));
    const ps = makeLivePs(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('10.0.1.5');
  });

  it('reflects an address set from cmd via netsh', async () => {
    const pc = makePc();
    await pc.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.2.9 255.255.255.0');
    const ps = makeLivePs(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('10.0.2.9');
  });
});

// ═══════════════════════════════════════════════════════════════════
// New-NetIPAddress — configures the real interface
// ═══════════════════════════════════════════════════════════════════

describe('New-NetIPAddress configures the real interface', () => {
  it('makes the address visible to ipconfig (cmd)', async () => {
    const pc = makePc();
    const sh = PowerShellSubShell.create(pc).subShell;
    await sh.processLine('New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.0.6.7 -PrefixLength 24');
    const out = await pc.executeCommand('ipconfig');
    expect(out).toContain('10.0.6.7');
  });

  it('actually sets the address on the underlying port', async () => {
    const pc = makePc();
    const sh = PowerShellSubShell.create(pc).subShell;
    await sh.processLine('New-NetIPAddress -InterfaceAlias eth0 -IPAddress 10.0.6.8 -PrefixLength 24');
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('10.0.6.8');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NetRoute — one routing table shared with route (cmd)
// ═══════════════════════════════════════════════════════════════════

describe('the NetRoute family shares the real routing table with route (cmd)', () => {
  const run = async (pc: WindowsPC, line: string): Promise<string> => {
    const sh = PowerShellSubShell.create(pc).subShell;
    return (await sh.processLine(line)).output.join('\n');
  };

  it('a route added via "route add" (cmd) is visible to Get-NetRoute', async () => {
    const pc = makePc();
    pc.configureInterface('eth0', new IPAddress('10.0.7.5'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('route add 172.16.9.0 mask 255.255.255.0 10.0.7.1');
    expect(await run(pc, 'Get-NetRoute')).toContain('172.16.9.0/24');
  });

  it('a route added via New-NetRoute (PS) is visible to "route print" (cmd)', async () => {
    const pc = makePc();
    pc.configureInterface('eth0', new IPAddress('10.0.8.5'), new SubnetMask('255.255.255.0'));
    await run(pc, 'New-NetRoute -DestinationPrefix "172.16.10.0/24" -InterfaceAlias eth0 -NextHop "10.0.8.1"');
    expect(await pc.executeCommand('route print')).toContain('172.16.10.0');
  });

  it('Remove-NetRoute removes the route from the real table', async () => {
    const pc = makePc();
    pc.configureInterface('eth0', new IPAddress('10.0.8.5'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('route add 172.16.11.0 mask 255.255.255.0 10.0.8.1');
    await run(pc, 'Remove-NetRoute -DestinationPrefix "172.16.11.0/24" -Confirm:$false');
    expect(await pc.executeCommand('route print')).not.toContain('172.16.11.0');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Get-NetTCPConnection — real socket table, no fabricated sockets
// ═══════════════════════════════════════════════════════════════════

describe('legacy Get-NetTCPConnection reflects the real socket table', () => {
  it('does not fabricate an Established connection to 8.8.8.8', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    const out = await ps.execute('Get-NetTCPConnection');
    expect(out).not.toContain('8.8.8.8');
  });

  it('every port it reports is also reported by netstat (cmd)', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    const psOut = await ps.execute('Get-NetTCPConnection');
    const cmdOut = await pc.executeCommand('netstat -an');
    const psPorts = [...psOut.matchAll(/^\s*\S+\s+(\d+)\s/gm)].map((m) => m[1]);
    for (const port of psPorts) {
      if (port === '0') continue;
      expect(cmdOut).toContain(port);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Resolve-DnsName — real resolver chain, no hardcoded answers
// ═══════════════════════════════════════════════════════════════════

describe('Resolve-DnsName resolves through the real chain', () => {
  it('resolves a hosts-file entry to its real address, not 192.168.1.1', async () => {
    const pc = makePc();
    await pc.executeCommand('echo 10.5.5.5 realhost.local >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    const ps = makeLivePs(pc);
    const out = await ps.execute('Resolve-DnsName realhost.local');
    expect(out).toContain('10.5.5.5');
    expect(out).not.toContain('192.168.1.1');
  });

  it('fails like nslookup for an unresolvable name instead of inventing 192.168.1.1', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    const out = await ps.execute('Resolve-DnsName no-such-host.nowhere');
    expect(out).not.toContain('192.168.1.1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scheduled tasks — schtasks (cmd) and Get/Register-ScheduledTask (PS)
// operate on the same store
// ═══════════════════════════════════════════════════════════════════

describe('legacy Get/Register-ScheduledTask share the schtasks store', () => {
  it('a task created via schtasks /create (cmd) is visible to Get-ScheduledTask (PS)', async () => {
    const pc = makePc();
    await pc.executeCommand('schtasks /create /tn CoherenceTask /tr "cmd /c echo hi" /sc daily /st 10:00');
    const ps = makeLivePs(pc);
    const out = await ps.execute('Get-ScheduledTask');
    expect(out).toContain('CoherenceTask');
  });

  it('does not report fabricated tasks that schtasks /query does not know', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    const psOut = await ps.execute('Get-ScheduledTask');
    const cmdOut = await pc.executeCommand('schtasks /query');
    const psNames = [...psOut.matchAll(/^\\?\S*\s{2,}(\S[^ ]*(?: [^ ]+)*?)\s{2,}\S+\s*$/gm)]
      .map((m) => m[1])
      .filter((n) => n && n !== 'TaskName' && !/^-+$/.test(n));
    for (const name of psNames) {
      expect(cmdOut).toContain(name);
    }
  });

  it('a task created via Register-ScheduledTask (PS) is visible to schtasks /query (cmd)', async () => {
    const pc = makePc();
    const ps = makeLivePs(pc);
    await ps.execute('Register-ScheduledTask -TaskName PsBornTask -Action X');
    const out = await pc.executeCommand('schtasks /query');
    expect(out).toContain('PsBornTask');
  });
});
