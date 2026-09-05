import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

describe('cmd ping — already sends 4 probes with a statistics summary', () => {
  it('an unresponsive target reports 4 attempts and full loss statistics, not just one line', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('ping 192.168.1.1');
    const attempts = (out.match(/PING: transmit failed\./g) ?? []).length;
    expect(attempts).toBe(4);
    expect(out).toMatch(/Packets: Sent = 4, Received = 0, Lost = 4/);
  });
});

describe('tracert — literal targets never trigger a false DNS failure', () => {
  it('an IPv4 literal is traced directly, no name-resolution error', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('tracert 192.168.1.1');
    expect(out).not.toMatch(/Unable to resolve target system name/);
  });

  it('an IPv6 literal gets an honest platform message, not a false name-resolution error', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('tracert -6 fe80::1');
    expect(out).not.toMatch(/Unable to resolve target system name/);
  });
});

describe('arp -s — respects the optional if_addr on a multi-homed host', () => {
  it('binds the static entry to the requested interface, not always the first', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    pc.configureInterface('eth1', new IPAddress('10.0.1.5'), new SubnetMask('255.255.255.0'));

    await pc.executeCommand('arp -s 10.0.1.50 00-11-22-33-44-55 10.0.1.5');
    const out = await pc.executeCommand('arp -a -N 10.0.1.5');
    expect(out).toMatch(/10\.0\.1\.50/);
    expect(out).toMatch(/00-11-22-33-44-55/);
  });
});

describe('New-NetIPAddress — mirrors onto the real port without duplicating the listing', () => {
  it('Get-NetIPAddress shows the new address exactly once', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);
    await run(shell, 'New-NetIPAddress -IPAddress 10.0.0.9 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    const out = await run(shell, 'Get-NetIPAddress -InterfaceAlias "Ethernet 0"');
    const count = (out.match(/10\.0\.0\.9/g) ?? []).length;
    expect(count).toBe(1);

    const cmdOut = await pc.executeCommand('ipconfig');
    expect(cmdOut).toContain('10.0.0.9');
  });
});

describe('Get-NetIPAddress -AddressFamily IPv4 — never leaks an IPv6 address', () => {
  it('excludes ::1 (IPv6 loopback) when filtered to IPv4', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);
    const out = await run(shell, 'Get-NetIPAddress -AddressFamily IPv4');
    expect(out).toContain('127.0.0.1');
    expect(out).not.toContain('::1');
  });
});

describe('Get-NetAdapterStatistics — real per-adapter counters', () => {
  it('reports non-fabricated counters backed by the port', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);

    const shell = ps(pc);
    const out = await run(shell, 'Get-NetAdapterStatistics');
    expect(out).toMatch(/ReceivedBytes|SentBytes/);
    expect(out).toContain('Ethernet 0');
  });
});

describe('Clear-NetNeighborCache — actually empties the ARP table', () => {
  it('removes entries so Get-NetNeighbor comes back empty', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.addStaticARP(new IPAddress('10.0.0.9'), new MACAddress('aa:bb:cc:dd:ee:ff'), 'eth0');
    const shell = ps(pc);
    const before = await run(shell, 'Get-NetNeighbor -IPAddress 10.0.0.9');
    expect(before).toMatch(/10\.0\.0\.9/);

    await run(shell, 'Clear-NetNeighborCache');
    const after = await run(shell, 'Get-NetNeighbor -IPAddress 10.0.0.9');
    expect(after).toContain("No MSFT_NetNeighbor objects found with property 'IPAddress' equal to '10.0.0.9'.");
    expect(after).not.toMatch(/aa-bb-cc-dd-ee-ff/i);
  });
});

describe('Test-NetConnection -TraceRoute — TraceRoute property is present', () => {
  it('includes a TraceRoute property even when the destination is unreachable', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);
    const out = await run(shell, 'Test-NetConnection 192.168.1.1 -TraceRoute');
    expect(out).toMatch(/TraceRoute/);
  });
});

describe('Get-NetAdapter — an uncabled but enabled port is Disconnected, not Up', () => {
  it('reports Disconnected status and no link speed for an unplugged adapter', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const shell = ps(pc);
    const out = await run(shell, 'Get-NetAdapter -Name "Ethernet 1"');
    expect(out).toMatch(/Ethernet 1\s.*\sDisconnected\s/);
    expect(out).not.toMatch(/Ethernet 1\s.*\sUp\s/);
    expect(out).toContain('0 bps');
  });

  it('a cabled adapter still reports Up with a real link speed', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    const shell = ps(pc);
    const out = await run(shell, 'Get-NetAdapter -Name "Ethernet 0"');
    expect(out).toMatch(/Ethernet 0\s.*\sUp\s/);
  });
});

describe('ipconfig /release — a connected adapter with no IP stays connected', () => {
  it('does not report "Media disconnected" for a cabled interface with no lease', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);

    const out = await pc.executeCommand('ipconfig /release');
    expect(out).not.toMatch(/Ethernet adapter Ethernet 0:\n\s*Connection-specific DNS Suffix\s*\.\s*:\n\s*Media State/);
  });
});

describe('arp -s via PowerShell — a hyphenated MAC literal is not parsed as arithmetic', () => {
  it('adds the static entry instead of printing the arp usage text', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    const shell = ps(pc);
    const psOut = await run(shell, 'arp -s 10.0.0.50 00-11-22-33-44-55');
    expect(psOut).not.toMatch(/ARP -s inet_addr/);

    const cmdOut = await pc.executeCommand('arp -a');
    expect(cmdOut).toContain('10.0.0.50');
    expect(cmdOut).toContain('00-11-22-33-44-55');
  });
});

describe('Disable-NetAdapter (PS) — brings down the real port, not just a PS-side label', () => {
  it('ipconfig (cmd) reports the interface down after Disable-NetAdapter (PS)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));

    const shell = ps(pc);
    await run(shell, 'Disable-NetAdapter -Name "Ethernet 0" -Confirm:$false');
    expect(pc.getPort('eth0')!.isAdminDown()).toBe(true);

    const cmdOut = await pc.executeCommand('ipconfig');
    expect(cmdOut).toMatch(/Media disconnected/i);

    await run(shell, 'Enable-NetAdapter -Name "Ethernet 0"');
    expect(pc.getPort('eth0')!.isAdminDown()).toBe(false);
  });
});

describe('Get-NetRoute / New-NetRoute — share the real routing table with route/netstat', () => {
  it('a route added via "route add" (cmd) is visible to Get-NetRoute (PS)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));

    await pc.executeCommand('route add 172.16.0.0 mask 255.255.0.0 10.0.0.1');

    const shell = ps(pc);
    const out = await run(shell, 'Get-NetRoute -DestinationPrefix 172.16.0.0/16');
    expect(out).toContain('172.16.0.0/16');
    expect(out).toContain('10.0.0.1');
  });

  it('a route added via New-NetRoute (PS) is visible to "route print" (cmd)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const router = new CiscoRouter('R1');
    new Cable('w').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));

    const shell = ps(pc);
    await run(shell, 'New-NetRoute -DestinationPrefix 172.16.1.0/24 -InterfaceAlias "Ethernet 0" -NextHop 10.0.0.1');

    const out = await pc.executeCommand('route print');
    expect(out).toContain('172.16.1.0');
  });
});

describe('netstat -r — real route table, matching route print', () => {
  it('renders the same routing table as "route print"', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));

    const routePrint = await pc.executeCommand('route print');
    const netstatR = await pc.executeCommand('netstat -r');
    expect(netstatR).toMatch(/IPv4 Route Table/);
    expect(netstatR).toContain('10.0.0.0');
    expect(netstatR).toBe(routePrint);
  });
});
