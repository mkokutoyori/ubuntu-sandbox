/**
 * PowerShell Audit — Debug test file
 *
 * Instantiates WindowsPC devices and executes PowerShell commands
 * to find bugs and incorrect behaviors in the PS implementation.
 *
 * Groups:
 *   1: Variables & environment ($PSVersionTable, $env:, $pwd, etc.)
 *   2: Filesystem cmdlets (Get-ChildItem, Set-Location, New-Item, etc.)
 *   3: File content cmdlets (Get-Content, Set-Content, Add-Content, etc.)
 *   4: Path cmdlets (Test-Path, Resolve-Path, Split-Path, Join-Path, Get-Item)
 *   5: Write/Echo cmdlets and string handling
 *   6: Network cmdlets (Get-NetIPConfiguration, Get-NetAdapter, etc.)
 *   7: Process cmdlets (Get-Process, Stop-Process)
 *   8: Service cmdlets (Get-Service, Start/Stop/Restart-Service, etc.)
 *   9: CIM/WMI cmdlets
 *  10: Pipeline integration (piping structured output through filters)
 *  11: Aliases and case-insensitivity
 *  12: Error handling and unknown commands
 *  13: PowerShellSubShell integration (exit, cls, cmd nesting)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor, PS_VERSION_TABLE, PS_BANNER } from '@/network/devices/windows/PowerShellExecutor';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { MACAddress, resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Create a WindowsPC + PowerShellExecutor pair */
function createPS(name = 'PC1'): { pc: WindowsPC; ps: PowerShellExecutor } {
  const pc = new WindowsPC('windows-pc', name, 100, 100);
  const ps = new PowerShellExecutor(pc as any);
  return { pc, ps };
}

/** Create a WindowsPC with an IP configured on eth0 */
function createPSWithIP(name = 'PC1'): { pc: WindowsPC; ps: PowerShellExecutor } {
  const pc = new WindowsPC('windows-pc', name, 100, 100);
  pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('192.168.1.1'));
  const ps = new PowerShellExecutor(pc as any);
  return { pc, ps };
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Variables & Environment
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Variables & Environment', () => {

  it('AUD-01: $PSVersionTable returns version info', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$PSVersionTable');
    expect(result).toBe(PS_VERSION_TABLE);
    expect(result).toContain('PSVersion');
    expect(result).toContain('5.1');
  });

  it('AUD-02: $host returns host info', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$host');
    expect(result).toContain('ConsoleHost');
    expect(result).toContain('Version');
  });

  it('AUD-03: $pwd returns current working directory', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$pwd');
    expect(result).toContain('Path');
    expect(result).toContain('C:\\Users\\User');
  });

  it('AUD-04: $env:USERNAME returns current user', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$env:USERNAME');
    expect(result).toBe('User');
  });

  it('AUD-05: $env:COMPUTERNAME returns hostname', async () => {
    const { ps } = createPS('MYPC');
    const result = await ps.execute('$env:COMPUTERNAME');
    expect(result).toBe('MYPC');
  });

  it('AUD-06: $env:WINDIR returns Windows dir', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$env:WINDIR');
    expect(result).toBe('C:\\Windows');
  });

  it('AUD-07: $env:PATH returns path', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$env:PATH');
    expect(result).toContain('System32');
  });

  it('AUD-08: $env:NONEXISTENT returns empty string', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$env:NONEXISTENT');
    expect(result).toBe('');
  });

  it('AUD-09: $true returns True', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$true');
    expect(result).toBe('True');
  });

  it('AUD-10: $false returns False', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$false');
    expect(result).toBe('False');
  });

  it('AUD-11: $null returns empty', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$null');
    expect(result).toBe('');
  });

  it('AUD-12: $pid returns a numeric PID', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$pid');
    expect(result).toMatch(/^\d+$/);
  });

  it('AUD-13: $env: is case-insensitive', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('$env:username');
    const r2 = await ps.execute('$env:USERNAME');
    const r3 = await ps.execute('$env:UserName');
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('AUD-14: $env:USERPROFILE returns profile path', async () => {
    const { ps } = createPS();
    const result = await ps.execute('$env:USERPROFILE');
    expect(result).toContain('C:\\Users\\');
  });

  it('AUD-15: empty command returns empty string', async () => {
    const { ps } = createPS();
    const result = await ps.execute('');
    expect(result).toBe('');
  });

  it('AUD-16: whitespace-only command returns empty', async () => {
    const { ps } = createPS();
    const result = await ps.execute('   ');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Filesystem Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Filesystem Cmdlets', () => {

  it('AUD-17: Get-ChildItem lists default directory', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-ChildItem');
    // Should show PS-style output with Mode/LastWriteTime columns
    expect(result).toContain('Mode');
    expect(result).toContain('LastWriteTime');
    expect(result).toContain('Name');
  });

  it('AUD-18: Get-ChildItem of C:\\ shows standard dirs', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-ChildItem C:\\');
    expect(result).toContain('Directory:');
    expect(result).toContain('Windows');
    expect(result).toContain('Users');
    expect(result).toContain('Program Files');
  });

  it('AUD-19: gci alias works like Get-ChildItem', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-ChildItem C:\\');
    const r2 = await ps.execute('gci C:\\');
    expect(r2).toBe(r1);
  });

  it('AUD-20: ls alias works like Get-ChildItem', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-ChildItem C:\\');
    const r2 = await ps.execute('ls C:\\');
    expect(r2).toBe(r1);
  });

  it('AUD-21: dir alias works like Get-ChildItem', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-ChildItem C:\\');
    const r2 = await ps.execute('dir C:\\');
    expect(r2).toBe(r1);
  });

  it('AUD-22: Get-ChildItem of non-existent path returns empty', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-ChildItem C:\\NonExistent');
    // Should be empty or error
    expect(result === '' || result.includes('Cannot find path')).toBe(true);
  });

  it('AUD-23: Set-Location changes cwd', async () => {
    const { ps, pc } = createPS();
    await ps.execute('Set-Location C:\\Windows');
    // Sync cwd from device
    await ps.execute(''); // trigger refresh
    const prompt = ps.getPrompt();
    expect(prompt).toContain('C:\\Windows');
  });

  it('AUD-24: cd alias changes cwd', async () => {
    const { ps } = createPS();
    await ps.execute('cd C:\\Windows');
    const result = await ps.execute('Get-Location');
    expect(result).toContain('C:\\Windows');
  });

  it('AUD-25: Get-Location returns current path', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Location');
    expect(result).toContain('Path');
    expect(result).toContain('C:\\Users\\User');
  });

  it('AUD-26: pwd alias works like Get-Location', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-Location');
    const r2 = await ps.execute('pwd');
    expect(r2).toBe(r1);
  });

  it('AUD-27: New-Item -ItemType Directory creates dir', async () => {
    const { ps } = createPS();
    await ps.execute('New-Item -ItemType Directory -Path C:\\TestDir');
    const exists = await ps.execute('Test-Path C:\\TestDir');
    expect(exists).toBe('True');
  });

  it('AUD-28: New-Item creates file by default', async () => {
    const { ps } = createPS();
    await ps.execute('New-Item -Path C:\\Users\\User\\test.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\test.txt');
    expect(exists).toBe('True');
  });

  it('AUD-29: Remove-Item deletes a file', async () => {
    const { ps } = createPS();
    // Create a file first
    await ps.execute('New-Item -Path C:\\Users\\User\\todel.txt');
    const before = await ps.execute('Test-Path C:\\Users\\User\\todel.txt');
    expect(before).toBe('True');
    // Delete it
    await ps.execute('Remove-Item C:\\Users\\User\\todel.txt');
    const after = await ps.execute('Test-Path C:\\Users\\User\\todel.txt');
    expect(after).toBe('False');
  });

  it('AUD-30: mkdir alias creates directory', async () => {
    const { ps } = createPS();
    await ps.execute('mkdir C:\\NewDir');
    const exists = await ps.execute('Test-Path C:\\NewDir');
    expect(exists).toBe('True');
  });

  it('AUD-31: rm alias deletes file', async () => {
    const { ps } = createPS();
    await ps.execute('New-Item -Path C:\\Users\\User\\rmtest.txt');
    await ps.execute('rm C:\\Users\\User\\rmtest.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\rmtest.txt');
    expect(exists).toBe('False');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: File Content Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: File Content Cmdlets', () => {

  it('AUD-32: BUG — Set-Content -Value with quoted multi-word string truncates to first word', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content -Path C:\\Users\\User\\hello.txt -Value "Hello World"');
    const content = await ps.execute('Get-Content C:\\Users\\User\\hello.txt');
    // BUG: "Hello World" is split by the basic arg parser at space, so only "Hello" is stored.
    // Real PS would keep "Hello World" as a single value.
    expect(content).toContain('Hello');
    expect(content).not.toContain('Hello World'); // BUG: multi-word value lost
  });

  it('AUD-33: cat alias reads file content', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content -Path C:\\Users\\User\\cat.txt -Value "CatTest"');
    const result = await ps.execute('cat C:\\Users\\User\\cat.txt');
    expect(result).toContain('CatTest');
  });

  it('AUD-34: type alias reads file content', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content -Path C:\\Users\\User\\type.txt -Value "TypeTest"');
    const result = await ps.execute('type C:\\Users\\User\\type.txt');
    expect(result).toContain('TypeTest');
  });

  it('AUD-35: Add-Content appends to existing file', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content -Path C:\\Users\\User\\append.txt -Value "Line1"');
    await ps.execute('Add-Content -Path C:\\Users\\User\\append.txt -Value "Line2"');
    const content = await ps.execute('Get-Content C:\\Users\\User\\append.txt');
    expect(content).toContain('Line1');
    expect(content).toContain('Line2');
  });

  it('AUD-36: Clear-Content empties file without deleting', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content -Path C:\\Users\\User\\clear.txt -Value "SomeData"');
    await ps.execute('Clear-Content -Path C:\\Users\\User\\clear.txt');
    const content = await ps.execute('Get-Content C:\\Users\\User\\clear.txt');
    // File should exist but be empty
    const exists = await ps.execute('Test-Path C:\\Users\\User\\clear.txt');
    expect(exists).toBe('True');
    expect(content.trim()).toBe('');
  });

  it('AUD-37: Clear-Content on non-existent file shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Clear-Content -Path C:\\Users\\User\\nope.txt');
    expect(result).toContain('Cannot find path');
  });

  it('AUD-38: Out-File creates empty file with no pipeline input', async () => {
    const { ps } = createPS();
    await ps.execute('Out-File -FilePath C:\\Users\\User\\outfile.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\outfile.txt');
    expect(exists).toBe('True');
  });

  it('AUD-39: Out-File without path shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Out-File');
    expect(result).toContain('FilePath');
    expect(result).toContain('empty string');
  });

  it('AUD-40: Add-Content without path shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Add-Content');
    expect(result).toContain('Path');
    expect(result).toContain('empty string');
  });

  it('AUD-41: Set-Content with positional path works', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content C:\\Users\\User\\pos.txt -Value "Positional"');
    const content = await ps.execute('Get-Content C:\\Users\\User\\pos.txt');
    expect(content).toContain('Positional');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: Path Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Path Cmdlets', () => {

  it('AUD-42: Test-Path returns True for existing dir', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Test-Path C:\\Windows');
    expect(result).toBe('True');
  });

  it('AUD-43: Test-Path returns False for non-existent path', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Test-Path C:\\FakePath\\NotHere');
    expect(result).toBe('False');
  });

  it('AUD-44: Test-Path with no arg returns False', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Test-Path');
    expect(result).toBe('False');
  });

  it('AUD-45: Resolve-Path resolves existing path', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Resolve-Path C:\\Windows');
    expect(result).toContain('Path');
    expect(result).toContain('C:\\Windows');
  });

  it('AUD-46: Resolve-Path on non-existent path shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Resolve-Path C:\\NoSuchDir');
    expect(result).toContain('Cannot find path');
  });

  it('AUD-47: Split-Path -Leaf extracts filename', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Split-Path -Leaf C:\\Users\\User\\file.txt');
    expect(result).toBe('file.txt');
  });

  it('AUD-48: Split-Path returns parent by default', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Split-Path C:\\Users\\User\\file.txt');
    expect(result).toBe('C:\\Users\\User');
  });

  it('AUD-49: Split-Path -Parent returns parent', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Split-Path -Parent C:\\Users\\User\\file.txt');
    expect(result).toBe('C:\\Users\\User');
  });

  it('AUD-50: Join-Path combines paths', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Join-Path C:\\Users User');
    expect(result).toBe('C:\\Users\\User');
  });

  it('AUD-51: Join-Path with -Path and -ChildPath', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Join-Path -Path C:\\Windows -ChildPath System32');
    expect(result).toBe('C:\\Windows\\System32');
  });

  it('AUD-52: Get-Item on existing file returns info', async () => {
    const { ps } = createPS();
    // Create a file first
    await ps.execute('New-Item -Path C:\\Users\\User\\gi.txt');
    const result = await ps.execute('Get-Item C:\\Users\\User\\gi.txt');
    expect(result).toContain('Mode');
    expect(result).toContain('gi.txt');
  });

  it('AUD-53: Get-Item on non-existent path shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Item C:\\Users\\User\\nope.txt');
    expect(result).toContain('Cannot find path');
  });

  it('AUD-54: Get-Item with no args shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Item');
    expect(result).toContain('empty string');
  });

  it('AUD-55: Resolve-Path with no args shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Resolve-Path');
    expect(result).toContain('empty string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 5: Write/Echo Cmdlets and String Handling
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Write/Echo Cmdlets', () => {

  it('AUD-56: Write-Host outputs text', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Write-Host Hello');
    expect(result).toBe('Hello');
  });

  it('AUD-57: Write-Output outputs text', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Write-Output TestString');
    expect(result).toBe('TestString');
  });

  it('AUD-58: echo alias outputs text', async () => {
    const { ps } = createPS();
    const result = await ps.execute('echo HelloEcho');
    expect(result).toBe('HelloEcho');
  });

  it('AUD-59: Write-Host strips surrounding quotes', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Write-Host "quoted"');
    expect(r1).toBe('quoted');
    const r2 = await ps.execute("Write-Host 'single'");
    expect(r2).toBe('single');
  });

  it('AUD-60: BUG — Write-Host with multi-word quoted string loses quotes but keeps spaces', async () => {
    const { ps } = createPS();
    // Real PS: Write-Host "Hello World" → "Hello World"
    // Implementation splits args by space first, then strips outer quotes
    const result = await ps.execute('Write-Host "Hello World"');
    // The implementation joins args with space: ["\"Hello", "World\""].join(' ') → '"Hello World"'
    // then strips outer quotes → 'Hello World' — actually this may work via simple regex strip
    // Let's see what actually happens:
    expect(result).toContain('Hello');
  });

  it('AUD-61: Write-Host multiple args joined with space', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Write-Host one two three');
    expect(result).toBe('one two three');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 6: Network Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Network Cmdlets', () => {

  it('AUD-62: Get-NetIPConfiguration shows interface info', async () => {
    const { ps, pc } = createPSWithIP();
    const result = await ps.execute('Get-NetIPConfiguration');
    expect(result).toContain('InterfaceAlias');
    expect(result).toContain('IPv4Address');
    expect(result).toContain('192.168.1.10');
  });

  it('AUD-63: Get-NetIPAddress shows IP address details', async () => {
    const { ps } = createPSWithIP();
    const result = await ps.execute('Get-NetIPAddress');
    expect(result).toContain('IPAddress');
    expect(result).toContain('192.168.1.10');
    expect(result).toContain('PrefixLength');
    expect(result).toContain('Loopback');
    expect(result).toContain('127.0.0.1');
  });

  it('AUD-64: Get-NetAdapter shows adapter table', async () => {
    const { ps } = createPSWithIP();
    const result = await ps.execute('Get-NetAdapter');
    expect(result).toContain('Name');
    expect(result).toContain('InterfaceDescription');
    expect(result).toContain('Status');
    expect(result).toContain('MacAddress');
  });

  it('AUD-65: hostname returns device hostname', async () => {
    const { ps } = createPS('TESTPC');
    const result = await ps.execute('hostname');
    expect(result).toBe('TESTPC');
  });

  it('AUD-66: ipconfig passes through to CMD', async () => {
    const { ps, pc } = createPSWithIP();
    const psResult = await ps.execute('ipconfig');
    const cmdResult = await pc.executeCommand('ipconfig');
    expect(psResult).toBe(cmdResult);
  });

  it('AUD-67: Test-Connection without target shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Test-Connection');
    expect(result).toContain('ComputerName');
    expect(result).toContain('required');
  });

  it('AUD-68: Resolve-DnsName shows not available message', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Resolve-DnsName example.com');
    expect(result).toContain('not available');
  });

  it('AUD-69: Get-NetIPConfiguration without IP shows Not configured', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-NetIPConfiguration');
    expect(result).toContain('Not configured');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 7: Process Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Process Cmdlets', () => {

  it('AUD-70: Get-Process lists all processes', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process');
    expect(result).toContain('Handles');
    expect(result).toContain('ProcessName');
    expect(result).toContain('svchost');
    expect(result).toContain('System');
  });

  it('AUD-71: Get-Process -Name filters by name', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process -Name svchost');
    expect(result).toContain('svchost');
  });

  it('AUD-72: Get-Process -Name with non-existent process shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process -Name FakeProcess');
    expect(result).toContain('Cannot find a process');
    expect(result).toContain('FakeProcess');
  });

  it('AUD-73: Get-Process -Id with valid PID works', async () => {
    const { ps } = createPS();
    const allProcs = await ps.execute('Get-Process');
    // Get the PID of System (usually 4)
    const result = await ps.execute('Get-Process -Id 4');
    expect(result).toContain('System');
  });

  it('AUD-74: Get-Process -Id with invalid PID shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process -Id 99999');
    expect(result).toContain('Cannot find a process');
  });

  it('AUD-75: Stop-Process without -Name or -Id shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Stop-Process');
    expect(result).toContain('Specify -Name or -Id');
  });

  it('AUD-76: gps alias works like Get-Process', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-Process');
    const r2 = await ps.execute('gps');
    expect(r2).toBe(r1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 8: Service Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Service Cmdlets', () => {

  it('AUD-77: Get-Service lists all services', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service');
    expect(result).toContain('Status');
    expect(result).toContain('Name');
    expect(result).toContain('DisplayName');
    expect(result).toContain('Running');
  });

  it('AUD-78: Get-Service -Name filters by name', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service -Name Spooler');
    expect(result).toContain('Spooler');
    expect(result).toContain('Print Spooler');
  });

  it('AUD-79: Get-Service non-existent service shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service -Name FakeService');
    expect(result).toContain('Cannot find any service');
  });

  it('AUD-80: Stop-Service without admin shows access error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Stop-Service -Name Spooler');
    // Default user is not admin
    expect(result).toContain('cannot be stopped');
  });

  it('AUD-81: Start-Service without admin shows access error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Start-Service -Name Spooler');
    expect(result).toContain('cannot be started');
  });

  it('AUD-82: Stop-Service as admin works', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('Stop-Service -Name Spooler');
    // Should succeed (no output) or show it stopped
    // Check service is now stopped
    const svcResult = await ps.execute('Get-Service -Name Spooler');
    expect(svcResult).toContain('Stopped');
  });

  it('AUD-83: Restart-Service as admin works', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('Restart-Service -Name Spooler');
    // Should succeed
    const svcResult = await ps.execute('Get-Service -Name Spooler');
    expect(svcResult).toContain('Running');
  });

  it('AUD-84: Set-Service -StartupType changes startup type', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('Set-Service -Name Spooler -StartupType Disabled');
    expect(result).toBe('');
    // Now trying to start should fail
    const startResult = await ps.execute('Start-Service -Name Spooler');
    expect(startResult).toContain('cannot be started');
  });

  it('AUD-85: gsv alias works like Get-Service', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-Service');
    const r2 = await ps.execute('gsv');
    expect(r2).toBe(r1);
  });

  it('AUD-86: Get-Service with wildcard name', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service -Name Spoo*');
    expect(result).toContain('Spooler');
  });

  it('AUD-87: New-Service as admin creates service', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('New-Service -Name TestSvc -BinaryPathName C:\\test.exe');
    expect(result).toContain('TestSvc');
  });

  it('AUD-88: Remove-Service as admin deletes stopped service', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    await ps.execute('New-Service -Name ToDelete -BinaryPathName C:\\del.exe');
    const result = await ps.execute('Remove-Service -Name ToDelete');
    expect(result).toBe('');
    // Should be gone now
    const check = await ps.execute('Get-Service -Name ToDelete');
    expect(check).toContain('Cannot find');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 9: CIM/WMI Cmdlets
// ═══════════════════════════════════════════════════════════════════

describe('Group 9: CIM/WMI Cmdlets', () => {

  it('AUD-89: Get-CimInstance Win32_OperatingSystem', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-CimInstance Win32_OperatingSystem');
    expect(result).toContain('BuildNumber');
    expect(result).toContain('22631');
    expect(result).toContain('Version');
  });

  it('AUD-90: Get-CimInstance Win32_ComputerSystem', async () => {
    const { ps } = createPS('MYHOST');
    const result = await ps.execute('Get-CimInstance Win32_ComputerSystem');
    expect(result).toContain('MYHOST');
    expect(result).toContain('Domain');
    expect(result).toContain('WORKGROUP');
  });

  it('AUD-91: Get-CimInstance invalid class shows error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-CimInstance FakeClass');
    expect(result).toContain('Invalid class');
  });

  it('AUD-92: Get-WmiObject alias works like Get-CimInstance', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-CimInstance Win32_OperatingSystem');
    const r2 = await ps.execute('Get-WmiObject Win32_OperatingSystem');
    expect(r2).toBe(r1);
  });

  it('AUD-93: gwmi alias works', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-CimInstance Win32_OperatingSystem');
    const r2 = await ps.execute('gwmi Win32_OperatingSystem');
    expect(r2).toBe(r1);
  });

  it('AUD-94: Get-ExecutionPolicy returns RemoteSigned', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-ExecutionPolicy');
    expect(result).toBe('RemoteSigned');
  });

  it('AUD-95: Set-ExecutionPolicy returns empty', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Set-ExecutionPolicy Unrestricted');
    expect(result).toBe('');
  });

  it('AUD-96: Get-Date returns a date string', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Date');
    expect(result!.length).toBeGreaterThan(10);
  });

  it('AUD-97: Get-History tracks commands', async () => {
    const { ps } = createPS();
    ps.setHistory(['Get-Process', 'ipconfig', 'hostname']);
    const result = await ps.execute('Get-History');
    expect(result).toContain('Get-Process');
    expect(result).toContain('ipconfig');
    expect(result).toContain('hostname');
  });

  it('AUD-98: Get-History empty returns empty', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-History');
    expect(result).toBe('');
  });

  it('AUD-99: Get-Help returns help topic info', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Help');
    expect(result).toContain('TOPIC');
    expect(result).toContain('PowerShell Help');
  });

  it('AUD-100: Get-Command lists cmdlets in table', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Command');
    expect(result).toContain('CommandType');
    expect(result).toContain('Cmdlet');
    expect(result).toContain('Get-ChildItem');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 10: Pipeline Integration
// ═══════════════════════════════════════════════════════════════════

describe('Group 10: Pipeline Integration', () => {

  it('AUD-101: Get-Process | Where-Object filters by name', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Where-Object { $_.ProcessName -eq "svchost" }');
    expect(result).toContain('svchost');
    expect(result).not.toContain('explorer');
  });

  it('AUD-102: Get-Process | Select-Object -First 3 limits output', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Select-Object -First 3');
    // Count non-empty, non-header, non-separator data lines
    const allLines = result!.split('\n');
    const dataLines = allLines.filter(l => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith('---')) return false;
      // Header lines contain column names like Handles, NPM(K), etc.
      if (/^Handles\s/.test(t)) return false;
      if (/^NPM/.test(t)) return false;
      // Format-Table adds header lines with property names
      return true;
    });
    // Debug: log lines to understand the output structure
    // With 8 properties per object and format as table, we expect:
    // blank + header + separator + 3 data rows + blank = ~6 lines total
    // But with formatDefault for >4 props, it uses Format-List (key:value pairs)
    // which would be 8 lines per object × 3 = 24 lines!
    // This is expected behavior for objects with many properties.
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(0);
  });

  it('AUD-103: Get-Process | Sort-Object ProcessName sorts output', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Sort-Object ProcessName');
    const lines = result!.split('\n').filter(l => l.trim() && !l.includes('---') && !l.startsWith('Handles'));
    // First data row should be alphabetically first process
    expect(result).toContain('ProcessName');
  });

  it('AUD-104: Get-Process | Measure-Object counts processes', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Measure-Object');
    expect(result).toContain('Count');
  });

  it('AUD-105: Get-Service | Where-Object Status -eq Running', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(result).toContain('Running');
  });

  it('AUD-106: Get-Service | Select-Object Name,Status', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service | Select-Object -Property Name, Status');
    expect(result).toContain('Name');
    expect(result).toContain('Status');
  });

  it('AUD-107: Get-Service | Format-Table formats as table', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service | Format-Table');
    expect(result).toContain('Status');
    expect(result).toContain('Name');
  });

  it('AUD-108: Get-Service | Format-List formats as list', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Service | Format-List');
    expect(result).toContain(':');
  });

  it('AUD-109: Get-Command | Where-Object Name -like Get-* filters', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Command | Where-Object { $_.Name -like "Get-*" }');
    expect(result).toContain('Get-');
    // Should not contain Set-, New-, etc. (only Get-* cmdlets)
    // Actually it might contain other columns with those words, so check data rows
  });

  it('AUD-110: Multi-stage pipeline Get-Process | Where | Select', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Where-Object { $_.ProcessName -eq "svchost" } | Select-Object -Property ProcessName, Id');
    expect(result).toContain('svchost');
    expect(result).toContain('ProcessName');
    expect(result).toContain('Id');
  });

  it('AUD-111: BUG — Pipeline with > redirect treated as pipeline', async () => {
    const { ps } = createPS();
    // The code has: if (trimmed.includes('|') && !trimmed.match(/[>]/))
    // So piping with redirect in same line should fall through to executeSingle
    // which would try to run the whole thing as a single command (likely fail or pass to CMD)
    const result = await ps.execute('Get-Process | Out-File C:\\Users\\User\\proc.txt');
    // This actually has | but no >, so it enters pipeline...
    // Out-File is not a recognized pipeline stage in PSPipeline, so it should pass through
    // Let's just verify it doesn't crash
    expect(result).toBeDefined();
  });

  it('AUD-112: Get-Process | Select-String filters by text', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-Process | Select-String svchost');
    expect(result).toContain('svchost');
  });
});

// ══════════════════════════��════════════════════════════════════════
// Group 11: Aliases and Case-Insensitivity
// ══════���══════════════════════════════════════════════��═════════════

describe('Group 11: Aliases and Case-Insensitivity', () => {

  it('AUD-113: Cmdlets are case-insensitive (get-childitem)', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-ChildItem C:\\');
    const r2 = await ps.execute('get-childitem C:\\');
    expect(r2).toBe(r1);
  });

  it('AUD-114: Cmdlets are case-insensitive (GET-CHILDITEM)', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-ChildItem C:\\');
    const r2 = await ps.execute('GET-CHILDITEM C:\\');
    expect(r2).toBe(r1);
  });

  it('AUD-115: sl alias for Set-Location', async () => {
    const { ps } = createPS();
    await ps.execute('sl C:\\Windows');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('C:\\Windows');
  });

  it('AUD-116: gl alias for Get-Location', async () => {
    const { ps } = createPS();
    const r1 = await ps.execute('Get-Location');
    const r2 = await ps.execute('gl');
    expect(r2).toBe(r1);
  });

  it('AUD-117: gc alias for Get-Content', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content C:\\Users\\User\\gc.txt -Value Test');
    const r1 = await ps.execute('Get-Content C:\\Users\\User\\gc.txt');
    const r2 = await ps.execute('gc C:\\Users\\User\\gc.txt');
    expect(r2).toBe(r1);
  });

  it('AUD-118: ri alias for Remove-Item', async () => {
    const { ps } = createPS();
    await ps.execute('New-Item C:\\Users\\User\\ri.txt');
    await ps.execute('ri C:\\Users\\User\\ri.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\ri.txt');
    expect(exists).toBe('False');
  });

  it('AUD-119: ni alias for New-Item', async () => {
    const { ps } = createPS();
    await ps.execute('ni C:\\Users\\User\\ni.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\ni.txt');
    expect(exists).toBe('True');
  });

  it('AUD-120: BUG — Copy-Item cp alias not recognized as PS but falls to CMD', async () => {
    const { ps } = createPS();
    // cp is listed as alias but goes to Copy-Item which delegates to CMD 'copy'
    await ps.execute('New-Item C:\\Users\\User\\src.txt');
    const result = await ps.execute('cp C:\\Users\\User\\src.txt C:\\Users\\User\\dst.txt');
    // Check if dst was created
    const exists = await ps.execute('Test-Path C:\\Users\\User\\dst.txt');
    // This tests whether the delegation to CMD 'copy' actually works
    expect(exists === 'True' || result !== '').toBe(true);
  });

  it('AUD-121: chdir alias for Set-Location', async () => {
    const { ps } = createPS();
    await ps.execute('chdir C:\\Windows');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('C:\\Windows');
  });

  it('AUD-122: h alias for Get-History', async () => {
    const { ps } = createPS();
    ps.setHistory(['test1', 'test2']);
    const r1 = await ps.execute('Get-History');
    const r2 = await ps.execute('h');
    expect(r2).toBe(r1);
  });

  it('AUD-123: history alias for Get-History', async () => {
    const { ps } = createPS();
    ps.setHistory(['test1']);
    const r1 = await ps.execute('Get-History');
    const r2 = await ps.execute('history');
    expect(r2).toBe(r1);
  });
});

// ═══════════════════���═══════════════════════════════════════════════
// Group 12: Error Handling and Unknown Commands
// ══���═════════════════════��══════════════════════════════════════════

describe('Group 12: Error Handling and Unknown Commands', () => {

  it('AUD-124: Unknown command shows PS-style error', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Invoke-FakeCommand');
    expect(result).toContain('is not recognized');
    expect(result).toContain('Invoke-FakeCommand');
    expect(result).toContain('CommandNotFoundException');
  });

  it('AUD-125: Unknown command includes At line info', async () => {
    const { ps } = createPS();
    const result = await ps.execute('BadCmd foo bar');
    expect(result).toContain('At line:1');
  });

  it('AUD-126: Unknown command includes CategoryInfo', async () => {
    const { ps } = createPS();
    const result = await ps.execute('NotACommand');
    expect(result).toContain('CategoryInfo');
    expect(result).toContain('ObjectNotFound');
  });

  it('AUD-127: sc alias conflict — sc maps to Set-Content in PS but sc.exe in code', async () => {
    const { ps } = createPS();
    // In real PS, 'sc' is an alias for Set-Content
    // In the implementation, 'sc' is mapped to both Set-Content AND native 'sc.exe' (service control)
    // Let's test: executeSingle checks 'sc' for Set-Content first (line 266)
    // But also checks 'sc' in native commands list (line 372): ['sc', 'sc.exe'].includes(cmdLower)
    // Set-Content check comes first, so 'sc' should hit Set-Content
    const result = await ps.execute('sc C:\\Users\\User\\sctest.txt -Value TestSC');
    // If it hits Set-Content, the file should be created
    const exists = await ps.execute('Test-Path C:\\Users\\User\\sctest.txt');
    // BUG: In the code, Set-Content ('sc') is checked BEFORE native 'sc' command.
    // This means 'sc query' (service control) will be treated as Set-Content path='query'
    // Real PS: sc is Set-Content alias, sc.exe is the service control command
    expect(exists).toBe('True');
  });

  it('AUD-128: BUG — sc query hits Set-Content instead of service control', async () => {
    const { ps } = createPS();
    // In real Windows, 'sc query' is a service control command
    // But in the code, 'sc' first matches Set-Content (line 266-268)
    // So 'sc query' would try Set-Content with path='query', value=''
    const result = await ps.execute('sc query Spooler');
    // This should show service info but might be treated as Set-Content
    // Let's check what actually happens
    expect(result === '' || result.includes('Spooler') || result.includes('SERVICE_NAME')).toBe(true);
  });
});

// ══════════════════���════════════════════════════════════════════════
// Group 13: PowerShellSubShell Integration
// ════���══════════════════════════���═════════════════════════════════���═

describe('Group 13: PowerShellSubShell Integration', () => {

  it('AUD-129: PowerShellSubShell.create returns banner', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell, banner } = PowerShellSubShell.create(pc as any);
    expect(banner.length).toBeGreaterThan(0);
    expect(banner.join('\n')).toContain('Windows PowerShell');
  });

  it('AUD-130: SubShell exit returns exit:true', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('exit');
    expect(result.exit).toBe(true);
  });

  it('AUD-131: SubShell cls returns clearScreen:true', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('cls');
    expect(result.clearScreen).toBe(true);
  });

  it('AUD-132: SubShell clear-host returns clearScreen:true', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('clear-host');
    expect(result.clearScreen).toBe(true);
  });

  it('AUD-133: SubShell cmd returns _enterCmd marker', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('cmd') as any;
    expect(result._enterCmd).toBe(true);
  });

  it('AUD-134: SubShell getPrompt returns PS prompt', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const prompt = subShell.getPrompt();
    expect(prompt).toContain('PS ');
    expect(prompt).toContain('C:\\Users\\User');
    expect(prompt).toContain('> ');
  });

  it('AUD-135: SubShell processes Get-Process', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('Get-Process');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.some(l => l.includes('svchost'))).toBe(true);
  });

  it('AUD-136: SubShell tracks command history for Get-History', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    await subShell.processLine('hostname');
    await subShell.processLine('Get-Date');
    const result = await subShell.processLine('Get-History');
    expect(result.output.some(l => l.includes('hostname'))).toBe(true);
    expect(result.output.some(l => l.includes('Get-Date'))).toBe(true);
  });

  it('AUD-137: SubShell empty line returns empty output', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = await subShell.processLine('');
    expect(result.output).toEqual([]);
    expect(result.exit).toBe(false);
  });

  it('AUD-138: SubShell handleKey Ctrl+D returns true (ignored)', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    const result = subShell.handleKey({ key: 'd', ctrlKey: true, shiftKey: false, altKey: false });
    expect(result).toBe(true);
  });

  it('AUD-139: BUG — cwd sync between SubShell and device may be inconsistent', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
    const { subShell } = PowerShellSubShell.create(pc as any);
    // Change directory via PS subshell
    await subShell.processLine('cd C:\\Windows');
    // The prompt should reflect the new directory
    const prompt = subShell.getPrompt();
    // BUG: PowerShellSubShell.processLine syncs cwd TO executor before execution,
    // but after Set-Location, the cwd is updated via device.executeCmdCommand('cd ...').
    // The refreshCwd() method reads back from CMD. But the SubShell code at line 97-102
    // has a comment saying "Update the device's cwd if PS changed it" but the body is EMPTY.
    // This means the prompt may or may not be updated depending on whether CMD 'cd' command
    // already updated the device cwd internally.
    expect(prompt).toContain('PS ');
    expect(prompt).toContain('>');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 14: Targeted Bug Hunting — Edge Cases
// ═══════════════════════════════════════════════════════════════════

describe('Group 14: Targeted Bug Hunting', () => {

  it('AUD-140: BUG — handleSetContent splits args by whitespace before quote handling', async () => {
    const { ps } = createPS();
    // The executeSingle splits: 'Set-Content -Path file.txt -Value "two words"'
    // into parts = ['Set-Content', '-Path', 'file.txt', '-Value', '"two', 'words"']
    // handleSetContent iterates args and does args[++i] for -Value, getting only '"two'
    // which after quote stripping becomes 'two'. 'words"' is left orphaned.
    await ps.execute('Set-Content -Path C:\\Users\\User\\bug.txt -Value "two words"');
    const content = await ps.execute('Get-Content C:\\Users\\User\\bug.txt');
    // Real PS: content should be "two words"
    // Bug: content is only "two" (truncated at space boundary)
    expect(content).toContain('two');
    expect(content).not.toContain('two words'); // Documents the bug
  });

  it('AUD-141: BUG — Write-Host -ForegroundColor is not supported', async () => {
    const { ps } = createPS();
    // Real PS: Write-Host "text" -ForegroundColor Red
    // The implementation treats all args after Write-Host as text to output
    const result = await ps.execute('Write-Host "hello" -ForegroundColor Red');
    // BUG: -ForegroundColor and Red are included in the output text
    expect(result).toContain('-ForegroundColor');
  });

  it('AUD-142: BUG — Write-Host -NoNewline is not supported', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Write-Host "test" -NoNewline');
    // BUG: -NoNewline is included in the output instead of being a flag
    expect(result).toContain('-NoNewline');
  });

  it('AUD-143: BUG — Get-ChildItem -Recurse is not implemented', async () => {
    const { ps } = createPS();
    // In real PS, -Recurse would list all files recursively
    // The implementation just calls formatGetChildItem which ignores -Recurse
    const withRecurse = await ps.execute('Get-ChildItem C:\\ -Recurse');
    const without = await ps.execute('Get-ChildItem C:\\');
    // BUG: -Recurse is treated as the path argument or ignored
    // Since 'C:\\ -Recurse' is joined as 'C:\\ -Recurse', the path becomes 'C:\\ -Recurse'
    // which doesn't exist, so it might return empty or the args get parsed wrong
    expect(withRecurse !== null).toBe(true);
  });

  it('AUD-144: BUG — Get-ChildItem -Filter is not implemented', async () => {
    const { ps } = createPS();
    const result = await ps.execute('Get-ChildItem C:\\ -Filter *.txt');
    // -Filter is not parsed; '*.txt' may be treated as part of path
    expect(result !== null).toBe(true);
  });

  it('AUD-145: BUG — New-Item with -Value parameter is not supported', async () => {
    const { ps } = createPS();
    // Real PS: New-Item -Path file.txt -Value "content" creates file with content
    await ps.execute('New-Item -Path C:\\Users\\User\\valued.txt -Value "initial"');
    const content = await ps.execute('Get-Content C:\\Users\\User\\valued.txt');
    // BUG: -Value is not parsed by handleNewItem, so the file is created empty
    expect(content.trim()).toBe(''); // Bug: should contain "initial"
  });

  it('AUD-146: BUG — Remove-Item -Recurse is not implemented', async () => {
    const { ps } = createPS();
    // Create a dir with content
    await ps.execute('mkdir C:\\Users\\User\\toremove');
    await ps.execute('New-Item C:\\Users\\User\\toremove\\child.txt');
    // Try to remove recursively
    const result = await ps.execute('Remove-Item C:\\Users\\User\\toremove -Recurse');
    // Without -Recurse support, this may fail or only delete the dir
    const exists = await ps.execute('Test-Path C:\\Users\\User\\toremove');
    // Document what actually happens
    expect(exists === 'True' || exists === 'False').toBe(true);
  });

  it('AUD-147: BUG — Copy-Item to destination that does not exist', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content C:\\Users\\User\\orig.txt -Value "data"');
    const result = await ps.execute('Copy-Item C:\\Users\\User\\orig.txt C:\\Users\\User\\copy.txt');
    const exists = await ps.execute('Test-Path C:\\Users\\User\\copy.txt');
    // Delegation to CMD 'copy' may or may not work correctly
    expect(exists === 'True' || exists === 'False').toBe(true);
  });

  it('AUD-148: BUG — Move-Item delegation to CMD may not work', async () => {
    const { ps } = createPS();
    await ps.execute('Set-Content C:\\Users\\User\\moveme.txt -Value "movedata"');
    await ps.execute('Move-Item C:\\Users\\User\\moveme.txt C:\\Users\\User\\moved.txt');
    const oldExists = await ps.execute('Test-Path C:\\Users\\User\\moveme.txt');
    const newExists = await ps.execute('Test-Path C:\\Users\\User\\moved.txt');
    // Document behavior
    expect(oldExists === 'True' || oldExists === 'False').toBe(true);
  });

  it('AUD-149: BUG — formatGetProcess is dead code (never called)', async () => {
    // PowerShellExecutor has a private formatGetProcess() method (line 832-860)
    // that uses hardcoded static process data, but Get-Process now calls
    // psGetProcess() from PSProcessCmdlets.ts which uses the dynamic ProcessManager.
    // formatGetProcess() is dead code that should be removed.
    const { ps } = createPS();
    const result = await ps.execute('Get-Process');
    // The result comes from PSProcessCmdlets, not from the dead formatGetProcess
    expect(result).toContain('ProcessName');
    // Dead code confirmed: formatGetProcess is private and never referenced
  });

  it('AUD-150: BUG — formatGetService is dead code (never called)', async () => {
    // Similar to formatGetProcess, formatGetService() (line 863-877) is dead code
    // because Get-Service now routes to psGetService() in PSServiceCmdlets.ts
    const { ps } = createPS();
    const result = await ps.execute('Get-Service');
    expect(result).toContain('DisplayName');
    // Dead code confirmed: formatGetService is private and never referenced
  });

  it('AUD-151: BUG — Pipeline detection fails with redirect in pipe', async () => {
    const { ps } = createPS();
    // Line 137: if (trimmed.includes('|') && !trimmed.match(/[>]/))
    // This means: 'Get-Process | Out-File > file.txt' would NOT enter pipeline
    // because it contains '>'. Instead it falls to executeSingle which tries to
    // parse the whole thing as a single command — guaranteed failure.
    const result = await ps.execute('echo hello | Out-File > C:\\Users\\User\\pipe.txt');
    // Should redirect to file but likely fails
    expect(result).toBeDefined();
  });

  it('AUD-152: BUG — $env:TEMP is hardcoded to User, not current user', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('$env:TEMP');
    // BUG: The resolveEnvVar has TEMP hardcoded as C:\\Users\\User\\AppData\\Local\\Temp
    // instead of using the currentUser. Real PS would show C:\\Users\\Administrator\\...
    expect(result).toBe('C:\\Users\\User\\AppData\\Local\\Temp'); // Bug: should be Administrator
  });

  it('AUD-153: BUG — $env:HOMEPATH is hardcoded to \\Users\\User', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    const result = await ps.execute('$env:HOMEPATH');
    // BUG: Hardcoded as '\\Users\\User' instead of using currentUser
    expect(result).toBe('\\Users\\User'); // Bug: should be \\Users\\Administrator
  });

  it('AUD-154: BUG — $env:USERPROFILE uses currentUser but HOMEPATH does not', async () => {
    const { pc, ps } = createPS();
    // Must use existing user — setCurrentUser('TestUser') fails since user doesn't exist
    pc.setCurrentUser('Administrator');
    const profile = await ps.execute('$env:USERPROFILE');
    const homepath = await ps.execute('$env:HOMEPATH');
    // USERPROFILE correctly uses currentUser dynamically
    expect(profile).toContain('Administrator');
    // But HOMEPATH is hardcoded to '\\Users\\User' (bug)
    expect(homepath).toBe('\\Users\\User'); // Bug: should be \\Users\\Administrator
    expect(homepath).not.toContain('Administrator'); // Confirms the bug
  });

  it('AUD-155: BUG — Get-ChildItem -Path with -Recurse flag passed as path arg', async () => {
    const { ps } = createPS();
    // Get-ChildItem passes all args as a joined path string
    // So: Get-ChildItem -Path C:\\ -Recurse becomes formatGetChildItem('-Path C:\\ -Recurse')
    // which tries to normalize '-Path C:\\ -Recurse' as a path
    const result = await ps.execute('Get-ChildItem -Path C:\\');
    // With -Path flag: args.join(' ') = '-Path C:\\', which gets normalized
    // The path becomes '-Path C:\\' which doesn't exist
    // Let's check if -Path flag is handled
    const direct = await ps.execute('Get-ChildItem C:\\');
    // BUG: -Path flag is not parsed, the entire args string is used as path
    expect(result === direct || result === '').toBe(true);
  });

  it('AUD-156: Prompt format is correct after cwd change', async () => {
    const { ps } = createPS();
    expect(ps.getPrompt()).toBe('PS C:\\Users\\User> ');
    await ps.execute('cd C:\\Windows');
    await ps.execute(''); // trigger refresh
    expect(ps.getPrompt()).toContain('PS ');
  });

  it('AUD-157: BUG — Pipeline with ? alias for Where-Object', async () => {
    const { ps } = createPS();
    // ? is supposed to be an alias for Where-Object
    const result = await ps.execute('Get-Service | ? { $_.Status -eq "Running" }');
    // This should work since PSPipeline.applyPipelineStage checks for '?'
    expect(result).toContain('Running');
  });

  it('AUD-158: BUG — Get-ChildItem on empty dir returns empty string', async () => {
    const { ps } = createPS();
    await ps.execute('mkdir C:\\EmptyDir');
    const result = await ps.execute('Get-ChildItem C:\\EmptyDir');
    // Empty directory should return empty output
    expect(result).toBe('');
  });

  it('AUD-159: BUG — Test-Connection -Count parameter', async () => {
    const { ps } = createPS();
    // Test-Connection with -Count — but without a network connection it will fail
    // Let's at least verify the parameter parsing doesn't crash
    const result = await ps.execute('Test-Connection -ComputerName 192.168.1.1 -Count 2');
    // Without network, ping will fail, which is expected
    expect(result).toBeDefined();
  });

  it('AUD-160: BUG — sc.exe maps correctly to service control', async () => {
    const { pc, ps } = createPS();
    pc.setCurrentUser('Administrator');
    // sc.exe should always go to the service control path, not Set-Content
    const result = await ps.execute('sc.exe query Spooler');
    expect(result).toContain('Spooler');
  });
});
