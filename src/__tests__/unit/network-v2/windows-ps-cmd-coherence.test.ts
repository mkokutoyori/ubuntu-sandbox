/**
 * PowerShell / CMD Output Coherence — TDD Test Suite
 *
 * Ensures that PowerShell cmdlets produce PS-style output that differs
 * from CMD-style output. Tests validate that PS has its own formatting
 * (Mode/LastWriteTime table for ls, object-style for network cmdlets, etc.)
 * while native commands (ipconfig, ping, etc.) pass through identically.
 *
 * Groups:
 *   1: Network commands pass-through (ipconfig, arp, route — same in both)
 *   2: System commands (hostname, systeminfo, ver — same in both)
 *   3: PS-specific formatting differs from CMD (Get-ChildItem vs dir, etc.)
 *   4: PS-specific cmdlets produce valid PS-style output
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellExecutor, PS_VERSION_TABLE, PS_BANNER } from '@/network/devices/windows/PowerShellExecutor';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Helper to get a WindowsPC with a configured IP */
function createConfiguredPC(name = 'PC1'): WindowsPC {
  const pc = new WindowsPC('windows-pc', name, 100, 100);
  return pc;
}

/** Helper to get a PowerShellExecutor backed by a WindowsPC */
function createPSExecutor(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc as any);
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Native command pass-through (same output in CMD and PS)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Native commands produce same output in CMD and PS', () => {

  it('PSC-1: ipconfig output matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('ipconfig');
    const psOutput = await ps.execute('ipconfig');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-2: ipconfig /all matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('ipconfig /all');
    const psOutput = await ps.execute('ipconfig /all');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-3: arp -a matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('arp -a');
    const psOutput = await ps.execute('arp -a');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-4: route print matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('route print');
    const psOutput = await ps.execute('route print');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-5: netsh interface show interface matches', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('netsh interface show interface');
    const psOutput = await ps.execute('netsh interface show interface');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-6: ping structure matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const pc2 = new LinuxPC('PC2', 200, 100);
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 150, 100);
    const cable1 = new Cable('c1');
    cable1.connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    const cable2 = new Cable('c2');
    cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc.executeCommand('netsh interface ipv4 set address name="Ethernet 0" static 192.168.1.10 255.255.255.0 192.168.1.1');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const ps = createPSExecutor(pc);

    // Both should produce Windows-style ping output (native pass-through)
    const cmdOutput = await pc.executeCommand('ping -n 1 192.168.1.20');
    const psOutput = await ps.execute('ping -n 1 192.168.1.20');

    // PS delegates 'ping' directly to device.executeCommand (native)
    expect(psOutput).toContain('Pinging 192.168.1.20');
    expect(psOutput).toContain('Reply from 192.168.1.20');
    expect(cmdOutput).toContain('Pinging 192.168.1.20');
    expect(cmdOutput).toContain('Reply from 192.168.1.20');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: System commands coherence
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: System commands produce same output in CMD and PS', () => {

  it('PSC-7: hostname matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('hostname');
    const psOutput = await ps.execute('hostname');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-8: systeminfo matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('systeminfo');
    const psOutput = await ps.execute('systeminfo');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-9: ver matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('ver');
    const psOutput = await ps.execute('ver');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-10: $env:COMPUTERNAME matches hostname', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const hostnameOutput = await pc.executeCommand('hostname');
    const envOutput = await ps.execute('$env:COMPUTERNAME');

    expect(envOutput).toBe(hostnameOutput);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: PS-specific formatting differs from CMD
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: PS cmdlets produce different format than CMD equivalents', () => {

  it('PSC-11: Get-ChildItem has PS table format (Mode/LastWriteTime/Length/Name)', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-ChildItem');
    const cmdOutput = await pc.executeCommand('dir');

    // PS output should have PS-style headers
    expect(psOutput).toContain('Mode');
    expect(psOutput).toContain('LastWriteTime');
    expect(psOutput).toContain('Length');
    expect(psOutput).toContain('Name');
    expect(psOutput).toContain('Directory:');

    // CMD output should have CMD-style headers
    expect(cmdOutput).toContain('Volume');
    expect(cmdOutput).toContain('<DIR>');

    // They should NOT be equal
    expect(psOutput).not.toBe(cmdOutput);
  });

  it('PSC-12: ls alias uses PS format, not CMD dir format', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('ls');

    // Should have PS-style mode flags like d----- or -a----
    expect(psOutput).toContain('Mode');
    expect(psOutput).toMatch(/[d-][a-][r-][h-][s-][l-]/);
    // Should NOT have CMD dir volume header
    expect(psOutput).not.toContain('Volume in drive');
  });

  it('PSC-13: Get-ChildItem shows correct mode flags', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-ChildItem');

    // User profile has directories like Desktop, Documents
    // Directories should show 'd' in mode
    expect(psOutput).toMatch(/d.{5}\s+/);
  });

  it('PSC-14: Get-NetIPConfiguration has PS object format', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-NetIPConfiguration');
    const cmdOutput = await pc.executeCommand('ipconfig');

    // PS format uses InterfaceAlias, IPv4Address properties
    expect(psOutput).toContain('InterfaceAlias');
    expect(psOutput).toContain('IPv4Address');
    expect(psOutput).toContain('IPv4DefaultGateway');

    // CMD format uses "Ethernet adapter", dots alignment
    expect(cmdOutput).toContain('Windows IP Configuration');

    expect(psOutput).not.toBe(cmdOutput);
  });

  it('PSC-15: Get-NetAdapter has PS table format', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-NetAdapter');

    expect(psOutput).toContain('Name');
    expect(psOutput).toContain('InterfaceDescription');
    expect(psOutput).toContain('Status');
    expect(psOutput).toContain('MacAddress');
    expect(psOutput).toContain('LinkSpeed');
    expect(psOutput).toContain('Ethernet');
  });

  it('PSC-16: Get-NetIPAddress has PS object format', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-NetIPAddress');

    expect(psOutput).toContain('IPAddress');
    expect(psOutput).toContain('InterfaceIndex');
    expect(psOutput).toContain('InterfaceAlias');
    expect(psOutput).toContain('AddressFamily');
    expect(psOutput).toContain('PrefixLength');
    // Should include loopback
    expect(psOutput).toContain('127.0.0.1');
    expect(psOutput).toContain('Loopback');
  });

  it('PSC-17: Get-Process has PS format (Handles/NPM/PM/WS/CPU), not tasklist format', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Get-Process');
    const cmdOutput = await pc.executeCommand('tasklist');

    // PS format
    expect(psOutput).toContain('Handles');
    expect(psOutput).toContain('NPM(K)');
    expect(psOutput).toContain('PM(K)');
    expect(psOutput).toContain('WS(K)');
    expect(psOutput).toContain('ProcessName');

    // CMD tasklist format
    expect(cmdOutput).toContain('Image Name');
    expect(cmdOutput).toContain('Session Name');
    expect(cmdOutput).toContain('Mem Usage');

    expect(psOutput).not.toBe(cmdOutput);
  });

  it('PSC-18: Test-Connection has PS table format, not CMD ping format', async () => {
    const pc = createConfiguredPC();
    const pc2 = new LinuxPC('PC2', 200, 100);
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 150, 100);
    const cable1 = new Cable('c1');
    cable1.connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    const cable2 = new Cable('c2');
    cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc.executeCommand('netsh interface ipv4 set address name="Ethernet 0" static 192.168.1.10 255.255.255.0 192.168.1.1');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const ps = createPSExecutor(pc);

    const psOutput = await ps.execute('Test-Connection -Count 1 192.168.1.20');

    // PS Test-Connection format
    expect(psOutput).toContain('Source');
    expect(psOutput).toContain('Destination');
    expect(psOutput).toContain('IPV4Address');
    expect(psOutput).toContain('Bytes');
    expect(psOutput).toContain('Time(ms)');

    // Should NOT have CMD ping format
    expect(psOutput).not.toContain('Pinging');
    expect(psOutput).not.toContain('Ping statistics');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: PS-specific cmdlets produce valid output
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: PS-specific cmdlets return valid data', () => {

  it('PSC-19: $PSVersionTable returns version info', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('$PSVersionTable');
    expect(output).toContain('PSVersion');
    expect(output).toContain('5.1');
    expect(output).toBe(PS_VERSION_TABLE);
  });

  it('PSC-20: Get-History returns command history', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    ps.setHistory(['ipconfig', 'ping 10.0.0.1', 'hostname']);
    const output = await ps.execute('Get-History');

    expect(output).toContain('1');
    expect(output).toContain('ipconfig');
    expect(output).toContain('ping 10.0.0.1');
    expect(output).toContain('hostname');
  });

  it('PSC-21: PS banner is well-formed', () => {
    expect(PS_BANNER).toContain('Windows PowerShell');
    expect(PS_BANNER).toContain('Microsoft Corporation');
  });

  it('PSC-22: $env variables return correct values', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    expect(await ps.execute('$env:USERNAME')).toBe('User');
    expect(await ps.execute('$env:SYSTEMROOT')).toBe('C:\\Windows');
    expect(await ps.execute('$env:WINDIR')).toBe('C:\\Windows');
    expect(await ps.execute('$env:USERPROFILE')).toBe('C:\\Users\\User');
    expect(await ps.execute('$env:OS')).toBe('Windows_NT');
  });

  it('PSC-23: Write-Host echoes text', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('Write-Host Hello World');
    expect(output).toBe('Hello World');
  });

  it('PSC-24: Get-Service returns service list', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('Get-Service');
    expect(output).toContain('Status');
    expect(output).toContain('Running');
  });

  it('PSC-25: type (CMD alias) and Get-Content (PS) return same content', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('type C:\\Windows\\System32\\drivers\\etc\\hosts');
    const psOutput = await ps.execute('Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts');

    // Both read the same file content
    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-26: tree output matches between CMD and PS (native pass-through)', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('tree C:\\Users');
    const psOutput = await ps.execute('tree C:\\Users');

    expect(psOutput).toBe(cmdOutput);
  });
});
