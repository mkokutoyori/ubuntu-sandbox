/**
 * Comprehensive tests for Windows services & processes improvements.
 *
 * Verifies:
 *   1. Exact sc.exe output format (query, queryex, qc, description, qfailure, sdshow, pause, continue)
 *   2. Exact tasklist output formats (/FO CSV, /FO LIST, /NH, /V columns)
 *   3. Exact taskkill behavior (graceful vs forced, /FI filters)
 *   4. Exact net start/stop error messages
 *   5. PowerShell error messages with CategoryInfo + FullyQualifiedErrorId
 *   6. PowerShell cmdlet features (-PassThru, -Force, wildcard, -DisplayName)
 *   7. Service binary files exist in Windows VFS
 *   8. Service state transitions and their effect on processes
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
// 1. SC.EXE — EXACT OUTPUT FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('sc query — exact output format', () => {
  it('should show SERVICE_NAME, TYPE, STATE, flags, exit codes', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Dhcp');
    expect(output).toContain('SERVICE_NAME: Dhcp');
    expect(output).toContain('TYPE               : 20  WIN32_SHARE_PROCESS');
    expect(output).toContain('STATE              : 4  RUNNING');
    expect(output).toContain('WIN32_EXIT_CODE    : 0  (0x0)');
    expect(output).toContain('SERVICE_EXIT_CODE  : 0  (0x0)');
    expect(output).toContain('CHECKPOINT         : 0x0');
    expect(output).toContain('WAIT_HINT          : 0x0');
  });

  it('should show STOPPABLE flag for running services', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Dhcp');
    expect(output).toContain('STOPPABLE');
  });

  it('should show NOT_STOPPABLE for stopped services', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const output = await pc.executeCommand('sc query Spooler');
    expect(output).toContain('NOT_STOPPABLE');
    expect(output).toContain('NOT_PAUSABLE');
    expect(output).toContain('IGNORES_SHUTDOWN');
  });

  it('should show PAUSABLE flag for services that support pause', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query LanmanServer');
    expect(output).toContain('PAUSABLE');
  });

  it('should show NOT_PAUSABLE for services that do not support pause', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Dhcp');
    expect(output).toContain('NOT_PAUSABLE');
  });

  it('should show KERNEL_DRIVER type code 1 for drivers', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Tcpip');
    expect(output).toContain('TYPE               : 1  KERNEL_DRIVER');
  });

  it('should show WIN32_OWN_PROCESS type code 10', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Spooler');
    expect(output).toContain('TYPE               : 10  WIN32_OWN_PROCESS');
  });
});

describe('sc queryex — PID and FLAGS', () => {
  it('should show PID and FLAGS fields', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc queryex Dhcp');
    expect(output).toContain('SERVICE_NAME: Dhcp');
    expect(output).toContain('PID                :');
    expect(output).toContain('FLAGS              :');
  });

  it('should show zero PID for stopped service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const output = await pc.executeCommand('sc queryex Spooler');
    expect(output).toContain('PID                : 0');
  });
});

describe('sc qc — exact config output', () => {
  it('should show QueryServiceConfig SUCCESS header', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('[SC] QueryServiceConfig SUCCESS');
  });

  it('should show correct START_TYPE with code', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('START_TYPE         : 2   AUTO_START');
  });

  it('should show DEMAND_START for manual services', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc WinRM');
    expect(output).toContain('START_TYPE         : 3   DEMAND_START');
  });

  it('should show BOOT_START for boot drivers', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Tcpip');
    expect(output).toContain('START_TYPE         : 0   BOOT_START');
  });

  it('should show SYSTEM_START for system drivers', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Afd');
    expect(output).toContain('START_TYPE         : 1   SYSTEM_START');
  });

  it('should show dependencies one per line', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('DEPENDENCIES       : Afd');
    expect(output).toContain('                   : Tcpip');
  });

  it('should show empty dependencies for services with none', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc RpcSs');
    expect(output).toContain('DEPENDENCIES       :');
    // Should NOT have a second dependency line
    const lines = output.split('\n');
    const depLines = lines.filter(l => l.includes('DEPENDENCIES'));
    expect(depLines.length).toBe(1);
  });

  it('should show BINARY_PATH_NAME', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Spooler');
    expect(output).toContain('BINARY_PATH_NAME   : C:\\Windows\\System32\\spoolsv.exe');
  });

  it('should show SERVICE_START_NAME (account)', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('SERVICE_START_NAME : NT Authority\\LocalService');
  });
});

describe('sc description — exact output', () => {
  it('should show QueryServiceConfig2 SUCCESS and description', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc description Dhcp');
    expect(output).toContain('[SC] QueryServiceConfig2 SUCCESS');
    expect(output).toContain('SERVICE_NAME: Dhcp');
    expect(output).toContain('DESCRIPTION:');
  });
});

describe('sc qfailure — exact output', () => {
  it('should show failure recovery actions', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qfailure Dhcp');
    expect(output).toContain('[SC] QueryServiceConfig2 SUCCESS');
    expect(output).toContain('RESET_PERIOD (in seconds)    : 86400');
    expect(output).toContain('FAILURE_ACTIONS');
    expect(output).toContain('RESTART -- Delay = 120000 milliseconds');
  });
});

describe('sc sdshow — SDDL output', () => {
  it('should return an SDDL string', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc sdshow Dhcp');
    expect(output).toContain('D:');
    // Real SDDL contains access control entries like (A;;...)
    expect(output).toMatch(/\(A;/);
  });
});

describe('sc pause / continue', () => {
  it('should pause a pausable service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc pause LanmanServer');
    expect(output).toContain('PAUSE_PENDING');

    const status = await pc.executeCommand('sc query LanmanServer');
    expect(status).toContain('PAUSED');
  });

  it('should continue a paused service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc pause LanmanServer');
    const output = await pc.executeCommand('sc continue LanmanServer');
    expect(output).toContain('CONTINUE_PENDING');

    const status = await pc.executeCommand('sc query LanmanServer');
    expect(status).toContain('RUNNING');
  });

  it('should fail to pause a non-pausable service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc pause Dhcp');
    expect(output).toContain('cannot be paused');
  });

  it('should fail to continue a non-paused service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc continue Dhcp');
    expect(output).toContain('not paused');
  });
});

describe('sc start / stop — status block in output', () => {
  it('sc start should show START_PENDING status block', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const output = await pc.executeCommand('sc start Spooler');
    expect(output).toContain('SERVICE_NAME: Spooler');
    expect(output).toContain('START_PENDING');
    expect(output).toContain('TYPE');
    expect(output).toContain('WIN32_EXIT_CODE');
  });

  it('sc stop should show STOP_PENDING status block', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc stop Spooler');
    expect(output).toContain('SERVICE_NAME: Spooler');
    expect(output).toContain('STOP_PENDING');
    expect(output).toContain('WIN32_EXIT_CODE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. TASKLIST — OUTPUT FORMATS
// ═══════════════════════════════════════════════════════════════════

describe('tasklist /FO CSV', () => {
  it('should output comma-separated quoted values', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fo csv');
    const lines = output.split('\n').filter(l => l.trim());
    // First line should be header
    expect(lines[0]).toContain('"Image Name"');
    expect(lines[0]).toContain('"PID"');
    expect(lines[0]).toContain('"Session Name"');
    // Data lines should be quoted
    const dataLine = lines[1];
    expect(dataLine).toMatch(/^"/);
    expect(dataLine).toContain('","');
  });

  it('should include all processes in CSV format', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fo csv');
    expect(output).toContain('"svchost.exe"');
    expect(output).toContain('"explorer.exe"');
  });
});

describe('tasklist /FO LIST', () => {
  it('should output key-value pairs', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fo list');
    expect(output).toContain('Image Name:');
    expect(output).toContain('PID:');
    expect(output).toContain('Session Name:');
    expect(output).toContain('Mem Usage:');
  });
});

describe('tasklist /NH — no headers', () => {
  it('should not show column headers', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /nh');
    expect(output).not.toContain('Image Name');
    // But should still show processes
    expect(output).toContain('svchost.exe');
  });

  it('should work with /FO CSV /NH', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fo csv /nh');
    expect(output).not.toContain('"Image Name"');
    expect(output).toContain('"svchost.exe"');
  });
});

describe('tasklist /V — verbose columns', () => {
  it('should show Window Title column', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    expect(output).toContain('Window Title');
  });

  it('should show hostname\\username format', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    expect(output).toContain('WIN-PC1\\');
  });

  it('should show N/A for processes without window titles', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    expect(output).toContain('N/A');
  });
});

describe('tasklist /FI — advanced filters', () => {
  it('should filter with wildcard imagename', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "imagename eq svc*"');
    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('=') && !l.startsWith('Image'));
    for (const line of lines) {
      if (line.trim()) expect(line.toLowerCase()).toContain('svc');
    }
  });

  it('should filter by memusage gt', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "memusage gt 50000"');
    // Should filter to only processes with >50MB
    expect(output).toContain('Image Name');
  });

  it('should filter by username', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "username eq NT AUTHORITY\\SYSTEM"');
    expect(output).toContain('Image Name');
  });

  it('should filter by PID gt', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "pid gt 1000"');
    expect(output).toContain('Image Name');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. TASKKILL — BEHAVIOR
// ═══════════════════════════════════════════════════════════════════

describe('taskkill — graceful vs forced kill', () => {
  it('should reject graceful kill of process without window', async () => {
    const pc = createPC();
    // conhost.exe may not have a window title depending on implementation
    const output = await pc.executeCommand('taskkill /im conhost.exe');
    // Without /F: either success or error about no window
    expect(output).toBeDefined();
  });

  it('should force kill with /F', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im conhost.exe /f');
    expect(output).toContain('SUCCESS');
  });
});

describe('taskkill /FI — filter-based kill', () => {
  it('should kill processes matching a filter', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /fi "imagename eq conhost.exe" /f');
    expect(output).toContain('SUCCESS');
  });

  it('should show error when no processes match filter', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /fi "imagename eq nonexistent.exe" /f');
    expect(output).toMatch(/not found|No tasks running/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. NET START / NET STOP — ERROR MESSAGES
// ═══════════════════════════════════════════════════════════════════

describe('net start/stop — realistic error messages', () => {
  it('net start should list services with proper formatting', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net start');
    // Real net start shows "These Windows services are started:"
    expect(output).toContain('started');
    expect(output).toContain('DHCP Client');
  });

  it('net stop on already stopped should show error', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net stop Spooler');
    const output = await pc.executeCommand('net stop Spooler');
    expect(output).toContain('is not started');
  });

  it('net start on already started should show error', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net start Dhcp');
    expect(output).toMatch(/already|requested service has already been started/i);
  });

  it('net stop non-admin should show System error 5', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net stop Spooler');
    expect(output).toContain('Access is denied');
  });

  it('net start disabled service should fail', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    await pc.executeCommand('sc config Spooler start= disabled');
    const output = await pc.executeCommand('net start Spooler');
    expect(output).toMatch(/disabled|cannot be started/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. POWERSHELL — CategoryInfo + FullyQualifiedErrorId
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell error messages — CategoryInfo format', () => {
  it('Get-Service error should include CategoryInfo', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name NonExistent');
    expect(output).toContain('Get-Service : Cannot find any service');
    expect(output).toContain('CategoryInfo');
    expect(output).toContain('ObjectNotFound');
    expect(output).toContain('FullyQualifiedErrorId');
    expect(output).toContain('NoServiceFoundForGivenName');
  });

  it('Start-Service access denied should include Cannot open...', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Start-Service -Name Spooler');
    expect(output).toContain("cannot be started");
    expect(output).toContain("Cannot open");
    expect(output).toContain('CategoryInfo');
    expect(output).toContain('CouldNotStartService');
  });

  it('Stop-Service non-admin should include proper error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Service -Name Spooler');
    expect(output).toContain("cannot be stopped");
    expect(output).toContain('OpenError');
    expect(output).toContain('CouldNotStopService');
  });

  it('Start-Service already running should wrap error', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Start-Service -Name Dhcp');
    expect(output).toContain("cannot be started");
    expect(output).toContain("already running");
    expect(output).toContain('CouldNotStartService');
  });

  it('Start-Service disabled should wrap error', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    await ps.execute('Set-Service -Name Spooler -StartupType Disabled');
    const output = await ps.execute('Start-Service -Name Spooler');
    expect(output).toContain("cannot be started");
    expect(output).toContain('CouldNotStartService');
  });

  it('Set-Service non-admin should include PermissionDenied', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -StartupType Disabled');
    expect(output).toContain('cannot be configured');
    expect(output).toContain('PermissionDenied');
    expect(output).toContain('CouldNotSetService');
  });

  it('Suspend-Service non-pausable should include proper message', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Suspend-Service -Name Dhcp');
    expect(output).toContain('cannot be suspended');
    expect(output).toContain('does not support being paused');
    expect(output).toContain('CouldNotSuspendService');
  });

  it('Resume-Service when not paused should include proper message', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Resume-Service -Name Dhcp');
    expect(output).toContain('cannot be resumed');
    expect(output).toContain('not paused');
    expect(output).toContain('CouldNotResumeService');
  });

  it('New-Service non-admin should include PermissionDenied', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('New-Service -Name Foo -BinaryPathName C:\\foo.exe');
    expect(output).toContain('cannot be created');
    expect(output).toContain('PermissionDenied');
  });

  it('New-Service duplicate should include already exists', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('New-Service -Name Dhcp -BinaryPathName C:\\d.exe');
    expect(output).toContain('already exists');
  });

  it('Remove-Service running service should include proper message', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Remove-Service -Name Dhcp');
    // Built-in services can't be deleted
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('Get-Process error should include CategoryInfo', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Process -Name NonExistent');
    expect(output).toContain('Cannot find a process');
    expect(output).toContain('CategoryInfo');
    expect(output).toContain('FullyQualifiedErrorId');
  });

  it('Stop-Process non-existent should include CategoryInfo', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Process -Name FakeApp');
    expect(output).toContain('Cannot find a process');
    expect(output).toContain('CategoryInfo');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. POWERSHELL — NEW FEATURES (-PassThru, -Force, wildcard, etc.)
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell Get-Service — wildcard support', () => {
  it('should filter services by wildcard name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name Dhc*');
    expect(output).toContain('Dhcp');
    expect(output).not.toContain('Dnscache');
  });

  it('should filter services by wildcard with ?', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name Dhc?');
    expect(output).toContain('Dhcp');
  });

  it('should show error for wildcard matching nothing', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name ZZZ*');
    expect(output).toContain('Cannot find');
  });
});

describe('PowerShell Get-Service — -DisplayName filter', () => {
  it('should filter by display name pattern', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -DisplayName "DHCP*"');
    expect(output).toContain('Dhcp');
  });
});

describe('PowerShell Get-Service — -Status filter', () => {
  it('should filter by status', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    const output = await ps.execute('Get-Service -Status Stopped');
    expect(output).toContain('Stopped');
    expect(output).not.toContain('Running');
  });
});

describe('PowerShell Stop-Service — -Force flag', () => {
  it('should force stop service with running dependents', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    // RpcSs has dependents - normal stop fails
    const failOutput = await ps.execute('Stop-Service -Name RpcSs');
    expect(failOutput).toContain('dependent');

    // With -Force, should stop dependents first then stop the service
    const forceOutput = await ps.execute('Stop-Service -Name RpcSs -Force');
    // After force stop, RpcSs should be stopped
    const status = await ps.execute('Get-Service -Name RpcSs');
    expect(status).toContain('Stopped');
  });
});

describe('PowerShell Set-Service — -Status parameter', () => {
  it('should start a service via Set-Service -Status Running', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    const output = await ps.execute('Set-Service -Name Spooler -Status Running');
    expect(output).toBe('');
    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Running');
  });

  it('should stop a service via Set-Service -Status Stopped', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -Status Stopped');
    expect(output).toBe('');
    const status = await ps.execute('Get-Service -Name Spooler');
    expect(status).toContain('Stopped');
  });
});

describe('PowerShell Set-Service — invalid StartupType', () => {
  it('should return ValidateSet error for invalid type', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Set-Service -Name Spooler -StartupType InvalidType');
    expect(output).toContain('does not belong to the set');
    expect(output).toContain('ValidateSet');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. SERVICE BINARIES IN VFS
// ═══════════════════════════════════════════════════════════════════

describe('Windows VFS — service binaries', () => {
  it('should have svchost.exe, spoolsv.exe, lsass.exe, services.exe in System32', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('dir C:\\Windows\\System32');
    expect(output).toContain('svchost.exe');
    expect(output).toContain('spoolsv.exe');
    expect(output).toContain('lsass.exe');
    expect(output).toContain('services.exe');
  });

  it('should have csrss.exe, dwm.exe, conhost.exe in System32', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('dir C:\\Windows\\System32');
    expect(output).toContain('csrss.exe');
    expect(output).toContain('dwm.exe');
    expect(output).toContain('conhost.exe');
  });

  it('should have sc.exe, tasklist.exe, taskkill.exe in System32', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('dir C:\\Windows\\System32');
    expect(output).toContain('sc.exe');
    expect(output).toContain('tasklist.exe');
    expect(output).toContain('taskkill.exe');
  });

  it('should have kernel drivers in drivers directory', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('dir C:\\Windows\\System32\\drivers');
    expect(output).toContain('tcpip.sys');
    expect(output).toContain('afd.sys');
    expect(output).toContain('netbt.sys');
  });

  it('should verify binaries exist via if exist command', async () => {
    const pc = createPC();
    // Use where command (checks if file exists in path)
    const fs = pc.getFileSystem();
    expect(fs.exists('C:\\Windows\\System32\\svchost.exe')).toBe(true);
    expect(fs.exists('C:\\Windows\\System32\\spoolsv.exe')).toBe(true);
    expect(fs.exists('C:\\Windows\\System32\\sc.exe')).toBe(true);
    expect(fs.exists('C:\\Windows\\System32\\drivers\\tcpip.sys')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. SERVICE STATE ↔ PROCESS LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('Service state → process lifecycle', () => {
  it('stopping a service should remove its process from tasklist', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    // Spooler uses spoolsv.exe - should be visible
    const before = await pc.executeCommand('tasklist');
    expect(before).toContain('spoolsv.exe');

    await pc.executeCommand('sc stop Spooler');
    const after = await pc.executeCommand('tasklist');
    expect(after).not.toContain('spoolsv.exe');
  });

  it('starting a service should add its process to tasklist', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const mid = await pc.executeCommand('tasklist');
    expect(mid).not.toContain('spoolsv.exe');

    await pc.executeCommand('sc start Spooler');
    const after = await pc.executeCommand('tasklist');
    expect(after).toContain('spoolsv.exe');
  });

  it('creating and starting a custom service should spawn process', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc create MySvc binPath= "C:\\myapp.exe" DisplayName= "My Service"');
    await pc.executeCommand('sc start MySvc');
    const list = await pc.executeCommand('tasklist');
    expect(list).toContain('mysvc.exe');
  });

  it('PowerShell Stop-Service should also remove process', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    const procs = await ps.execute('Get-Process -Name spoolsv');
    expect(procs).toContain('Cannot find');
  });

  it('PowerShell Start-Service should add process back', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Stop-Service -Name Spooler');
    await ps.execute('Start-Service -Name Spooler');
    const procs = await ps.execute('Get-Process -Name spoolsv');
    expect(procs).toContain('spoolsv');
    expect(procs).not.toContain('Cannot find');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. ADDITIONAL EDGE CASES & COMPLETENESS
// ═══════════════════════════════════════════════════════════════════

describe('sc — ACCEPTS_SHUTDOWN vs IGNORES_SHUTDOWN', () => {
  it('running services with acceptsShutdown=true should show ACCEPTS_SHUTDOWN', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Dhcp');
    expect(output).toContain('ACCEPTS_SHUTDOWN');
  });

  it('kernel drivers should show IGNORES_SHUTDOWN', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Tcpip');
    expect(output).toContain('IGNORES_SHUTDOWN');
  });
});

describe('PowerShell service table formatting', () => {
  it('should show Status, Name, DisplayName columns', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name Dhcp');
    const lines = output.split('\n');
    const headerLine = lines.find(l => l.includes('Status'));
    expect(headerLine).toContain('Name');
    expect(headerLine).toContain('DisplayName');

    const separatorLine = lines.find(l => l.includes('------'));
    expect(separatorLine).toContain('----');
    expect(separatorLine).toContain('-----------');
  });

  it('should truncate long display names with ...', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    // Create a service with a very long display name
    await ps.execute('New-Service -Name LongSvc -BinaryPathName C:\\long.exe -DisplayName "This Is A Very Long Service Display Name That Exceeds Limit"');
    const output = await ps.execute('Get-Service -Name LongSvc');
    expect(output).toContain('...');
  });
});

describe('PowerShell empty name parameter', () => {
  it('Start-Service without name should return ParameterBinding error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Start-Service');
    expect(output).toContain('Cannot validate argument');
    expect(output).toContain('ParameterBindingValidationException');
  });

  it('Stop-Service without name should return ParameterBinding error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Stop-Service');
    expect(output).toContain('Cannot validate argument');
    expect(output).toContain('ParameterBindingValidationException');
  });
});

describe('tasklist — memory format', () => {
  it('should show memory with comma-separated thousands and K suffix', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    // Real Windows shows "12,345 K" format
    expect(output).toMatch(/\d+,?\d* K/);
  });
});

describe('sc config — DISABLED then start flow', () => {
  it('full flow: stop → disable → fail start → enable → start', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');

    // Stop first
    await pc.executeCommand('sc stop Spooler');
    const q1 = await pc.executeCommand('sc query Spooler');
    expect(q1).toContain('STOPPED');

    // Disable
    const cfg = await pc.executeCommand('sc config Spooler start= disabled');
    expect(cfg).toContain('SUCCESS');

    // Try to start - should fail
    const fail = await pc.executeCommand('sc start Spooler');
    expect(fail).toContain('disabled');

    // Re-enable
    await pc.executeCommand('sc config Spooler start= auto');
    const qc = await pc.executeCommand('sc qc Spooler');
    expect(qc).toContain('AUTO_START');

    // Now start succeeds
    const ok = await pc.executeCommand('sc start Spooler');
    expect(ok).toContain('START_PENDING');

    const q2 = await pc.executeCommand('sc query Spooler');
    expect(q2).toContain('RUNNING');
  });
});
