/**
 * PowerShell / CMD Output Coherence — TDD Test Suite
 *
 * Ensures that commands available in both CMD and PowerShell modes
 * produce consistent outputs. Tests validate that PS cmdlets
 * properly delegate to the underlying CMD-level commands.
 *
 * Groups:
 *   1: Network commands (ipconfig, ping, arp, route, tracert)
 *   2: System commands (hostname, systeminfo, ver)
 *   3: File commands (dir/Get-ChildItem, type/Get-Content, cd/Set-Location)
 *   4: PS-specific cmdlets produce valid output
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
  const pc = new WindowsPC(name, 100, 100);
  // Configure IP via CMD
  return pc;
}

/** Helper to get a PowerShellExecutor backed by a WindowsPC */
function createPSExecutor(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor({
    executeCommand: (cmd: string) => pc.executeCommand(cmd),
    getHostname: () => pc.getHostname(),
  });
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Network command coherence
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Network commands produce same output in CMD and PS', () => {

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

  it('PSC-6: ping output matches between CMD and PS', async () => {
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

    // Both should produce Windows-style ping output
    const cmdOutput = await pc.executeCommand('ping -n 1 192.168.1.20');
    const psOutput = await ps.execute('ping -n 1 192.168.1.20');

    // PS delegates 'ping' directly to device.executeCommand
    // RTT values may differ slightly between calls, so compare structure
    expect(psOutput).toContain('Pinging 192.168.1.20');
    expect(psOutput).toContain('Reply from 192.168.1.20');
    expect(psOutput).toContain('Packets: Sent = 1, Received = 1');
    // Same structure as CMD
    expect(cmdOutput).toContain('Pinging 192.168.1.20');
    expect(cmdOutput).toContain('Reply from 192.168.1.20');
    expect(cmdOutput).toContain('Packets: Sent = 1, Received = 1');
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
// Group 3: File system commands coherence
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: File commands produce coherent output', () => {

  it('PSC-11: dir and Get-ChildItem list same items', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('dir');
    const psOutput = await ps.execute('Get-ChildItem');

    // Both should list the same directory contents
    // PS output is derived from dir output
    expect(cmdOutput).toBeDefined();
    expect(psOutput).toBeDefined();

    // PS output should contain the same directory entries as CMD
    if (cmdOutput!.includes('<DIR>')) {
      // If there are directories in CMD output, PS should also list them
      const cmdDirs = cmdOutput!.split('\n').filter(l => l.includes('<DIR>'));
      for (const dirLine of cmdDirs) {
        const dirName = dirLine.split('<DIR>')[1]?.trim();
        if (dirName) {
          expect(psOutput).toContain(dirName);
        }
      }
    }
  });

  it('PSC-12: cd (CMD) and Set-Location (PS) produce same effect', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    // Both start at C:\Users\User
    const cmdCd = await pc.executeCommand('cd');
    expect(cmdCd).toContain('Users');

    const psCd = await ps.execute('Get-Location');
    expect(psCd).toContain('Users');
  });

  it('PSC-13: type (CMD) and Get-Content (PS) return same content', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    // Create a test file first
    await pc.executeCommand('echo test content > C:\\test.txt');

    const cmdOutput = await pc.executeCommand('type C:\\test.txt');
    const psOutput = await ps.execute('Get-Content C:\\test.txt');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-14: tree output matches between CMD and PS', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const cmdOutput = await pc.executeCommand('tree C:\\Users');
    const psOutput = await ps.execute('tree C:\\Users');

    expect(psOutput).toBe(cmdOutput);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: PS-specific cmdlets produce valid output
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: PS-specific cmdlets return valid data', () => {

  it('PSC-15: $PSVersionTable returns version info', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('$PSVersionTable');
    expect(output).toContain('PSVersion');
    expect(output).toContain('5.1');
    expect(output).toBe(PS_VERSION_TABLE);
  });

  it('PSC-16: Get-NetIPConfiguration returns IP info', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('Get-NetIPConfiguration');
    expect(output).toBeDefined();
    // Should contain adapter info similar to ipconfig
    expect(output).toContain('Ethernet');
  });

  it('PSC-17: Get-Process returns process list', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    // Get-Process delegates to tasklist
    const cmdOutput = await pc.executeCommand('tasklist');
    const psOutput = await ps.execute('Get-Process');

    expect(psOutput).toBe(cmdOutput);
  });

  it('PSC-18: Get-History returns command history', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    ps.setHistory(['ipconfig', 'ping 10.0.0.1', 'hostname']);
    const output = await ps.execute('Get-History');

    expect(output).toContain('1');
    expect(output).toContain('ipconfig');
    expect(output).toContain('ping 10.0.0.1');
    expect(output).toContain('hostname');
  });

  it('PSC-19: PS banner is well-formed', () => {
    expect(PS_BANNER).toContain('Windows PowerShell');
    expect(PS_BANNER).toContain('Microsoft Corporation');
  });

  it('PSC-20: $env variables return correct values', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    expect(await ps.execute('$env:USERNAME')).toBe('User');
    expect(await ps.execute('$env:SYSTEMROOT')).toBe('C:\\Windows');
    expect(await ps.execute('$env:WINDIR')).toBe('C:\\Windows');
    expect(await ps.execute('$env:USERPROFILE')).toBe('C:\\Users\\User');
    expect(await ps.execute('$env:OS')).toBe('Windows_NT');
  });

  it('PSC-21: Write-Host echoes text', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('Write-Host Hello World');
    expect(output).toBe('Hello World');
  });

  it('PSC-22: Get-Service returns service list', async () => {
    const pc = createConfiguredPC();
    const ps = createPSExecutor(pc);

    const output = await ps.execute('Get-Service');
    expect(output).toContain('Status');
    expect(output).toContain('Running');
  });
});
