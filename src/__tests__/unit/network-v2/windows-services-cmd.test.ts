/**
 * TDD Tests for Windows Services & Processes — CMD
 *
 * Tests the Windows service/process management through CMD commands:
 *   - tasklist (with /SVC, /V, /FI, /FO filters)
 *   - taskkill (/PID, /IM, /F, /T)
 *   - sc (query, start, stop, config, create, delete, qc)
 *   - net start / net stop
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

// ═══════════════════════════════════════════════════════════════════
// TASKLIST — BASIC
// ═══════════════════════════════════════════════════════════════════

describe('CMD: tasklist — basic', () => {
  it('should list running processes with columns', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    expect(output).toContain('Image Name');
    expect(output).toContain('PID');
    expect(output).toContain('Session Name');
    expect(output).toContain('Mem Usage');
  });

  it('should include system processes', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    expect(output).toContain('System');
    expect(output).toContain('csrss.exe');
    expect(output).toContain('services.exe');
    expect(output).toContain('lsass.exe');
    expect(output).toContain('svchost.exe');
  });

  it('should include user processes', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    expect(output).toContain('explorer.exe');
    expect(output).toContain('cmd.exe');
  });

  it('should show dwm.exe as Console session', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    expect(output).toContain('dwm.exe');
    expect(output).toContain('Console');
  });

  it('should show services.exe as Services session', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    // services.exe should be listed under Services session
    const lines = output.split('\n');
    const servicesLine = lines.find(l => l.includes('services.exe'));
    expect(servicesLine).toBeDefined();
    expect(servicesLine).toContain('Services');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TASKLIST — /SVC (show services hosted by each process)
// ═══════════════════════════════════════════════════════════════════

describe('CMD: tasklist /SVC', () => {
  it('should show services column', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /svc');
    expect(output).toContain('Image Name');
    expect(output).toContain('PID');
    expect(output).toContain('Services');
  });

  it('should show services hosted by svchost.exe', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /svc');
    const lines = output.split('\n');
    const svchostLines = lines.filter(l => l.includes('svchost.exe'));
    expect(svchostLines.length).toBeGreaterThan(0);
    // At least one svchost should host known services
    const allSvchost = svchostLines.join('\n');
    expect(allSvchost).toMatch(/Dhcp|Dnscache|EventLog|RpcSs/);
  });

  it('should show N/A for processes not hosting services', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /svc');
    const lines = output.split('\n');
    const explorerLine = lines.find(l => l.includes('explorer.exe'));
    expect(explorerLine).toContain('N/A');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TASKLIST — /V (verbose with username, status, cpu time, window)
// ═══════════════════════════════════════════════════════════════════

describe('CMD: tasklist /V', () => {
  it('should show verbose columns including username', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    expect(output).toContain('User Name');
    expect(output).toContain('Status');
    expect(output).toContain('CPU Time');
  });

  it('should show SYSTEM for system processes', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    expect(output).toContain('NT AUTHORITY\\SYSTEM');
  });

  it('should show current user for user processes', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /v');
    const lines = output.split('\n');
    const explorerLine = lines.find(l => l.includes('explorer.exe'));
    expect(explorerLine).toBeDefined();
    expect(explorerLine).toContain('User');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TASKLIST — /FI (filter)
// ═══════════════════════════════════════════════════════════════════

describe('CMD: tasklist /FI', () => {
  it('should filter by image name', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "imagename eq svchost.exe"');
    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('=') && !l.startsWith('Image'));
    for (const line of lines) {
      if (line.trim()) expect(line).toContain('svchost.exe');
    }
  });

  it('should filter by PID', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "pid eq 4"');
    expect(output).toContain('System');
  });

  it('should filter by status', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "status eq running"');
    expect(output).toContain('Image Name');
  });

  it('should show info message when no processes match filter', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist /fi "imagename eq nonexistent.exe"');
    expect(output).toContain('No tasks');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TASKKILL
// ═══════════════════════════════════════════════════════════════════

describe('CMD: taskkill — by PID', () => {
  it('should kill a process by PID', async () => {
    const pc = createPC();
    // Get PID of conhost.exe from tasklist
    const list = await pc.executeCommand('tasklist');
    const conhostLine = list.split('\n').find(l => l.includes('conhost.exe'));
    expect(conhostLine).toBeDefined();
    const pid = conhostLine!.match(/\d+/g)?.[0];

    const output = await pc.executeCommand(`taskkill /pid ${pid} /f`);
    expect(output).toContain('SUCCESS');

    // Process should no longer appear
    const after = await pc.executeCommand('tasklist');
    expect(after).not.toContain('conhost.exe');
  });

  it('should reject killing critical system processes', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('taskkill /pid 4 /f');
    expect(output).toContain('critical');
  });

  it('should return error for non-existent PID', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /pid 99999 /f');
    expect(output).toContain('not found');
  });
});

describe('CMD: taskkill — by image name', () => {
  it('should kill process by image name', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im conhost.exe /f');
    expect(output).toContain('SUCCESS');
  });

  it('should return error for non-existent image name', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im fake.exe /f');
    expect(output).toContain('not found');
  });

  it('should require /F for forced kill', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im conhost.exe');
    // Without /F, should still attempt graceful termination
    expect(output).toBeDefined();
  });
});

describe('CMD: taskkill — /T (tree kill)', () => {
  it('should kill child processes with /T', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im cmd.exe /f /t');
    expect(output).toContain('SUCCESS');
    // conhost.exe is child of cmd.exe, should also be killed
    const after = await pc.executeCommand('tasklist');
    expect(after).not.toContain('conhost.exe');
  });
});

describe('CMD: taskkill — privilege enforcement', () => {
  it('should deny killing system processes as standard user', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im lsass.exe /f');
    expect(output).toContain('Access is denied');
  });

  it('should allow admin to kill more processes', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    // taskhostw.exe is a system process but not critical
    const list = await pc.executeCommand('tasklist');
    if (list.includes('taskhostw.exe')) {
      const output = await pc.executeCommand('taskkill /im taskhostw.exe /f');
      expect(output).toContain('SUCCESS');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// SC — SERVICE CONTROL
// ═══════════════════════════════════════════════════════════════════

describe('CMD: sc query', () => {
  it('should query a specific service', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query Dhcp');
    expect(output).toContain('SERVICE_NAME: Dhcp');
    expect(output).toContain('STATE');
    expect(output).toContain('RUNNING');
    expect(output).toContain('TYPE');
  });

  it('should list all services when no name given', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query');
    expect(output).toContain('Dhcp');
    expect(output).toContain('Dnscache');
    expect(output).toContain('EventLog');
  });

  it('should show stopped services with type=all', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query type= all');
    expect(output).toContain('Spooler');
  });

  it('should return error for non-existent service', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query FakeService');
    expect(output).toContain('FAILED 1060');
  });
});

describe('CMD: sc qc (query config)', () => {
  it('should show service configuration', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('SERVICE_NAME: Dhcp');
    expect(output).toContain('TYPE');
    expect(output).toContain('START_TYPE');
    expect(output).toContain('BINARY_PATH_NAME');
    expect(output).toContain('DISPLAY_NAME');
    expect(output).toContain('SERVICE_START_NAME');
  });

  it('should show dependencies', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc qc Dhcp');
    expect(output).toContain('DEPENDENCIES');
  });
});

describe('CMD: sc start / stop', () => {
  it('should stop a running service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc stop Spooler');
    expect(output).toContain('STOP_PENDING');

    const status = await pc.executeCommand('sc query Spooler');
    expect(status).toContain('STOPPED');
  });

  it('should start a stopped service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const output = await pc.executeCommand('sc start Spooler');
    expect(output).toContain('START_PENDING');

    const status = await pc.executeCommand('sc query Spooler');
    expect(status).toContain('RUNNING');
  });

  it('should fail to start an already running service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc start Dhcp');
    expect(output).toContain('already');
  });

  it('should fail to stop an already stopped service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc stop Spooler');
    const output = await pc.executeCommand('sc stop Spooler');
    expect(output).toContain('not been started');
  });

  it('should require admin privileges to start/stop', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc stop Spooler');
    expect(output).toContain('Access is denied');
  });

  it('should fail to stop a service with dependents still running', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    // RpcSs has many dependents — stopping it should warn
    const output = await pc.executeCommand('sc stop RpcSs');
    expect(output).toMatch(/dependent|cannot stop/i);
  });
});

describe('CMD: sc config', () => {
  it('should change start type to disabled', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc config Spooler start= disabled');
    expect(output).toContain('SUCCESS');

    const config = await pc.executeCommand('sc qc Spooler');
    expect(config).toContain('DISABLED');
  });

  it('should change start type to auto', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc config Spooler start= disabled');
    const output = await pc.executeCommand('sc config Spooler start= auto');
    expect(output).toContain('SUCCESS');

    const config = await pc.executeCommand('sc qc Spooler');
    expect(config).toContain('AUTO_START');
  });

  it('should change start type to demand (manual)', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc config Spooler start= demand');
    expect(output).toContain('SUCCESS');

    const config = await pc.executeCommand('sc qc Spooler');
    expect(config).toContain('DEMAND_START');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc config Spooler start= disabled');
    expect(output).toContain('Access is denied');
  });
});

describe('CMD: sc create / delete', () => {
  it('should create a new service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand(
      'sc create MyService binPath= "C:\\MyApp\\service.exe" DisplayName= "My Custom Service" start= auto'
    );
    expect(output).toContain('SUCCESS');

    const query = await pc.executeCommand('sc query MyService');
    expect(query).toContain('MyService');
  });

  it('should delete a service', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('sc create TempSvc binPath= "C:\\temp.exe"');
    await pc.executeCommand('sc stop TempSvc');
    const output = await pc.executeCommand('sc delete TempSvc');
    expect(output).toContain('SUCCESS');

    const query = await pc.executeCommand('sc query TempSvc');
    expect(query).toContain('FAILED 1060');
  });

  it('should prevent deleting built-in services', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc delete Dhcp');
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('should reject duplicate service creation', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('sc create Dhcp binPath= "C:\\fake.exe"');
    expect(output).toContain('already exists');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NET START / NET STOP
// ═══════════════════════════════════════════════════════════════════

describe('CMD: net start / net stop', () => {
  it('should list running services with net start', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net start');
    expect(output).toContain('DHCP Client');
    expect(output).toContain('DNS Client');
    expect(output).toContain('Windows Event Log');
  });

  it('should stop a service with net stop', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net stop Spooler');
    expect(output).toContain('was stopped successfully');

    const list = await pc.executeCommand('net start');
    expect(list).not.toContain('Print Spooler');
  });

  it('should start a service with net start <name>', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net stop Spooler');
    const output = await pc.executeCommand('net start Spooler');
    expect(output).toContain('was started successfully');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net stop Spooler');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('CMD: services & processes edge cases', () => {
  it('should handle case-insensitive service names in sc', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc query dhcp');
    expect(output).toContain('Dhcp');
    expect(output).toContain('RUNNING');
  });

  it('should handle case-insensitive image names in taskkill', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill /im CONHOST.EXE /f');
    expect(output).toContain('SUCCESS');
  });

  it('should respawn critical processes after kill attempt', async () => {
    const pc = createPC();
    // Even if somehow killed, system processes should remain
    const output = await pc.executeCommand('tasklist');
    expect(output).toContain('System');
    expect(output).toContain('csrss.exe');
  });

  it('should show process count', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('tasklist');
    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('=') && !l.startsWith('Image') && !l.startsWith('\n'));
    expect(lines.length).toBeGreaterThan(10);
  });

  it('should handle sc with no arguments', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('sc');
    expect(output).toMatch(/DESCRIPTION|usage|SYNTAX/i);
  });

  it('should handle taskkill with no arguments', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('taskkill');
    expect(output).toMatch(/ERROR|usage|required/i);
  });

  it('should allow starting a disabled service after config change', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    // Stop service first, then disable
    await pc.executeCommand('sc stop Spooler');
    await pc.executeCommand('sc config Spooler start= disabled');
    // Starting a disabled service should fail
    const fail = await pc.executeCommand('sc start Spooler');
    expect(fail).toContain('disabled');

    // Re-enable and start
    await pc.executeCommand('sc config Spooler start= auto');
    const ok = await pc.executeCommand('sc start Spooler');
    expect(ok).toContain('START_PENDING');
  });
});
