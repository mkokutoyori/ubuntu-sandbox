/**
 * TDD Tests for Windows Services & Processes — PowerShell
 *
 * Tests the Windows service/process management through PowerShell cmdlets:
 *   - Get-Process (-Name, -Id), Stop-Process (-Name, -Id, -Force)
 *   - Get-Service (-Name, -Status), Start-Service, Stop-Service
 *   - Restart-Service, Set-Service, Suspend-Service, Resume-Service
 *   - New-Service, Remove-Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-PC1'): WindowsPC {
  return new WindowsPC('windows-pc', name);
}

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc);
}

// ═══════════════════════════════════════════════════════════════════
// GET-PROCESS
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Get-Process — list all', () => {
  it('should list all running processes', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process');
    expect(output).toContain('ProcessName');
    expect(output).toContain('Id');
    expect(output).toContain('svchost');
    expect(output).toContain('csrss');
    expect(output).toContain('explorer');
  });

  it('should show Handles, NPM, PM, WS, CPU columns', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process');
    expect(output).toContain('Handles');
    expect(output).toContain('NPM(K)');
    expect(output).toContain('PM(K)');
    expect(output).toContain('WS(K)');
    expect(output).toContain('CPU(s)');
  });
});

describe('PowerShell: Get-Process — by name', () => {
  it('should filter by process name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Name svchost');
    expect(output).toContain('svchost');
    expect(output).not.toContain('explorer');
  });

  it('should return error for non-existent process name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Name FakeProcess');
    expect(output).toContain('Cannot find a process');
  });

  it('should handle case-insensitive process name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Name SVCHOST');
    expect(output).toContain('svchost');
  });
});

describe('PowerShell: Get-Process — by Id', () => {
  it('should filter by process ID', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Id 4');
    expect(output).toContain('System');
  });

  it('should return error for non-existent PID', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Id 99999');
    expect(output).toContain('Cannot find a process');
  });
});

// ═══════════════════════════════════════════════════════════════════
// STOP-PROCESS
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Stop-Process', () => {
  it('should stop a process by name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Process -Name conhost');
    expect(output).toBe('');

    const list = await ps.execute('Get-Process');
    expect(list).not.toContain('conhost');
  });

  it('should stop a process by Id', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Use the known PID for conhost.exe (5132) from the process manager
    const output = await ps.execute('Stop-Process -Id 5132');
    expect(output).toBe('');
  });

  it('should reject stopping critical system processes', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Process -Name csrss');
    expect(output).toContain('critical');
  });

  it('should return error for non-existent process', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Process -Name FakeApp');
    expect(output).toContain('Cannot find a process');
  });

  it('should deny stopping system processes as standard user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Process -Name lsass');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET-SERVICE
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Get-Service — list all', () => {
  it('should list all services', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service');
    expect(output).toContain('Status');
    expect(output).toContain('Name');
    expect(output).toContain('DisplayName');
    expect(output).toContain('Dhcp');
    expect(output).toContain('Running');
  });

  it('should include both running and stopped services', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    // Stop a service first
    await ps.execute('Stop-Service -Name Spooler');
    const output = await ps.execute('Get-Service');
    expect(output).toContain('Running');
    expect(output).toContain('Stopped');
  });
});

describe('PowerShell: Get-Service — by name', () => {
  it('should filter by service name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name Dhcp');
    expect(output).toContain('Dhcp');
    expect(output).toContain('DHCP Client');
  });

  it('should return error for non-existent service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name FakeSvc');
    expect(output).toContain('Cannot find');
  });

  it('should handle case-insensitive service name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name dhcp');
    expect(output).toContain('Dhcp');
  });
});

// ═══════════════════════════════════════════════════════════════════
// START-SERVICE / STOP-SERVICE / RESTART-SERVICE
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Start-Service / Stop-Service', () => {
  it('should stop a running service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Service -Name Spooler');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Stopped');
  });

  it('should start a stopped service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    const output = await ps.execute('Start-Service -Name Spooler');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Running');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Service -Name Spooler');
    expect(output).toContain('Access is denied');
  });

  it('should fail to stop a service with running dependents', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Service -Name RpcSs');
    expect(output).toMatch(/dependent|cannot stop/i);
  });
});

describe('PowerShell: Restart-Service', () => {
  it('should restart a running service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Restart-Service -Name Spooler');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Running');
  });

  it('should start a stopped service via restart', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    const output = await ps.execute('Restart-Service -Name Spooler');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Running');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Restart-Service -Name Spooler');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SET-SERVICE
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Set-Service', () => {
  it('should change startup type to Disabled', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -StartupType Disabled');
    expect(output).toBe('');
  });

  it('should change startup type to Manual', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -StartupType Manual');
    expect(output).toBe('');
  });

  it('should change display name', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Set-Service -Name Spooler -DisplayName "Custom Print Spooler"');
    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Custom Print Spooler');
  });

  it('should change description', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -Description "My custom description"');
    expect(output).toBe('');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -StartupType Disabled');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SUSPEND-SERVICE / RESUME-SERVICE
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Suspend-Service / Resume-Service', () => {
  it('should pause a running service that supports pause', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Suspend-Service -Name LanmanServer');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name LanmanServer');
    expect(status).toContain('Paused');
  });

  it('should resume a paused service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Suspend-Service -Name LanmanServer');
    const output = await ps.execute('Resume-Service -Name LanmanServer');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name LanmanServer');
    expect(status).toContain('Running');
  });

  it('should fail to pause a service that does not support pause', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Suspend-Service -Name Dhcp');
    expect(output).toContain('cannot be paused');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NEW-SERVICE / REMOVE-SERVICE
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: New-Service / Remove-Service', () => {
  it('should create a new service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute(
      'New-Service -Name "TestSvc" -BinaryPathName "C:\\test.exe" -DisplayName "Test Service"'
    );
    expect(output).toContain('TestSvc');

    const status = await ps.execute('Get-Service -Name TestSvc');
    expect(status).toContain('Stopped');
  });

  it('should create service with startup type', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute(
      'New-Service -Name "AutoSvc" -BinaryPathName "C:\\auto.exe" -StartupType Automatic'
    );
    const status = await ps.execute('Get-Service -Name AutoSvc');
    expect(status).toContain('AutoSvc');
  });

  it('should reject duplicate service name', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute(
      'New-Service -Name "Dhcp" -BinaryPathName "C:\\fake.exe"'
    );
    expect(output).toContain('already exists');
  });

  it('should remove a custom service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-Service -Name "ToRemove" -BinaryPathName "C:\\rm.exe"');
    const output = await ps.execute('Remove-Service -Name "ToRemove"');
    expect(output).toBe('');

    const status = await ps.execute('Get-Service -Name ToRemove');
    expect(status).toContain('Cannot find');
  });

  it('should prevent removing built-in services', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Remove-Service -Name "Dhcp"');
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('should require admin for creation', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute(
      'New-Service -Name "Hack" -BinaryPathName "C:\\bad.exe"'
    );
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: services & processes edge cases', () => {
  it('should handle case-insensitive cmdlet names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('get-service');
    expect(output).toContain('Dhcp');
  });

  it('should handle pipeline Get-Service | Where-Object', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(output).toContain('Running');
    expect(output).not.toContain('Stopped');
  });

  it('should handle pipeline Get-Process | Sort-Object', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process | Sort-Object Id');
    expect(output).toContain('ProcessName');
    // Should have content (not error)
    expect(output!.split('\n').length).toBeGreaterThan(5);
  });

  it('should reflect service state in Get-Process after stop', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    // Stopping Spooler service should remove its process
    await ps.execute('Stop-Service -Name Spooler');
    const procs = await ps.execute('Get-Process -Name spoolsv');
    expect(procs).toContain('Cannot find');
  });

  it('should handle multiple operations in sequence', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-Service -Name "Svc1" -BinaryPathName "C:\\s1.exe"');
    await ps.execute('New-Service -Name "Svc2" -BinaryPathName "C:\\s2.exe"');
    await ps.execute('Start-Service -Name Svc1');
    await ps.execute('Start-Service -Name Svc2');
    await ps.execute('Stop-Service -Name Svc1');

    const s1 = await ps.execute('Get-Service -Name Svc1');
    const s2 = await ps.execute('Get-Service -Name Svc2');
    expect(s1).toContain('Stopped');
    expect(s2).toContain('Running');
  });
});
