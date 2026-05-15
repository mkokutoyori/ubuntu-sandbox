// ═══════════════════════════════════════════════════════════════════════════
// machine-state.test.ts — PowerShell machine‑level integration tests
// ═══════════════════════════════════════════════════════════════════════════
// These tests execute real PowerShell scripts on a simulated Windows PC
// and verify that the state of the machine (files, users, groups, etc.)
// changes as expected.

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-STATE'): WindowsPC {
  return new WindowsPC('windows-pc', name);
}

function createPS(pc: WindowsPC): PowerShellSubShell {
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FILE SYSTEM – DIRECTORIES & FILES
// ═══════════════════════════════════════════════════════════════════════════

describe('1. File System – Directories & Files', () => {

  // 1.1 New-Item – directories
  it('New-Item creates a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\TestDir -ItemType Directory');
    const exists = await run(ps, 'Test-Path C:\\TestDir');
    expect(exists.trim()).toBe('True');
  });

  it('New-Item creates an empty file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\empty.txt -ItemType File');
    const content = await run(ps, 'Get-Content C:\\empty.txt');
    expect(content.trim()).toBe('');
  });

  it('New-Item with -Value writes content', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\greet.txt -ItemType File -Value "hello world"');
    const content = await run(ps, 'Get-Content C:\\greet.txt');
    expect(content.trim()).toBe('hello world');
  });

  it.skip('New-Item throws on duplicate directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\dup -ItemType Directory');
    const result = await run(ps, 'New-Item -Path C:\\dup -ItemType Directory -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  // 1.2 Get-Content / Set-Content / Add-Content
  it('Set-Content overwrites file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content -Path C:\\data.txt -Value "first"');
    await run(ps, 'Set-Content -Path C:\\data.txt -Value "second"');
    const content = await run(ps, 'Get-Content C:\\data.txt');
    expect(content.trim()).toBe('second');
  });

  it('Add-Content appends to file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content -Path C:\\log.txt -Value "line1"');
    await run(ps, 'Add-Content -Path C:\\log.txt -Value "line2"');
    const content = await run(ps, 'Get-Content C:\\log.txt');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it.skip('Get-Content with -Tail returns last lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, '1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const tail = await run(ps, 'Get-Content C:\\numbers.txt -Tail 2');
    const lines = tail.split(/\r?\n/).filter(l => l !== '');
    expect(lines).toEqual(['4', '5']);
  });

  it.skip('Get-Content with -TotalCount returns first lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, '"a","b","c" | Set-Content C:\\abc.txt');
    const head = await run(ps, 'Get-Content C:\\abc.txt -TotalCount 2');
    const lines = head.split(/\r?\n/).filter(l => l !== '');
    expect(lines).toEqual(['a', 'b']);
  });

  // 1.3 Copy-Item / Move-Item / Remove-Item
  it('Copy-Item duplicates a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content -Path C:\\orig.txt -Value "original"');
    await run(ps, 'Copy-Item -Path C:\\orig.txt -Destination C:\\copy.txt');
    const content = await run(ps, 'Get-Content C:\\copy.txt');
    expect(content.trim()).toBe('original');
  });

  it.skip('Copy-Item can copy to a different drive', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content -Path C:\\source.txt -Value "data"');
    await run(ps, 'Copy-Item C:\\source.txt D:\\backup.txt');
    const content = await run(ps, 'Get-Content D:\\backup.txt');
    expect(content.trim()).toBe('data');
  });

  it('Move-Item renames a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content -Path C:\\oldname.txt -Value "content"');
    await run(ps, 'Move-Item -Path C:\\oldname.txt -Destination C:\\newname.txt');
    const existsOld = await run(ps, 'Test-Path C:\\oldname.txt');
    expect(existsOld.trim()).toBe('False');
    const content = await run(ps, 'Get-Content C:\\newname.txt');
    expect(content.trim()).toBe('content');
  });

  it('Move-Item moves a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\FolderA -ItemType Directory');
    await run(ps, 'Set-Content -Path C:\\FolderA\\file.txt -Value "inside"');
    await run(ps, 'Move-Item -Path C:\\FolderA -Destination C:\\FolderB');
    const content = await run(ps, 'Get-Content C:\\FolderB\\file.txt');
    expect(content.trim()).toBe('inside');
  });

  it('Remove-Item deletes a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\todel.txt -ItemType File');
    await run(ps, 'Remove-Item C:\\todel.txt');
    const exists = await run(ps, 'Test-Path C:\\todel.txt');
    expect(exists.trim()).toBe('False');
  });

  it('Remove-Item deletes a directory recursively', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\Dir -ItemType Directory');
    await run(ps, 'New-Item -Path C:\\Dir\subfile.txt -ItemType File');
    await run(ps, 'Remove-Item -Path C:\\Dir -Recurse');
    const exists = await run(ps, 'Test-Path C:\\Dir');
    expect(exists.trim()).toBe('False');
  });

  // 1.4 Wildcards & recurse
  it('Get-ChildItem with -Filter returns matching files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\img -ItemType Directory');
    await run(ps, 'New-Item -Path C:\\img\\photo1.jpg -ItemType File');
    await run(ps, 'New-Item -Path C:\\img\\photo2.png -ItemType File');
    const jpgs = await run(ps, 'Get-ChildItem C:\\img -Filter *.jpg');
    expect(jpgs).toContain('photo1.jpg');
    expect(jpgs).not.toContain('photo2.png');
  });

  it('Get-ChildItem -Recurse lists all files in subtree', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\tree\\level1\\level2 -ItemType Directory -Force');
    await run(ps, 'Set-Content -Path C:\\tree\\level1\\level2\deep.txt -Value "deep"');
    const all = await run(ps, 'Get-ChildItem -Path C:\\tree -Recurse');
    expect(all).toContain('deep.txt');
  });

  // 1.5 Resolve-Path & Join-Path
  it('Resolve-Path returns the fully qualified path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\resolve\\file.txt -ItemType File -Force');
    const resolved = await run(ps, 'Resolve-Path C:\\resolve\\.\\file.txt');
    expect(resolved.trim()).toContain('C:\\resolve\\file.txt');
  });

  it('Join-Path constructs a valid path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await run(ps, 'Join-Path C:\\Users Document');
    expect(result.trim()).toBe('C:\\Users\\Document');
  });

  // 1.6 Clear-Content
  it('Clear-Content empties a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Content C:\\clear.txt "data"');
    await run(ps, 'Clear-Content C:\\clear.txt');
    const content = await run(ps, 'Get-Content C:\\clear.txt');
    expect(content.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. LOCAL USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Local User Management', () => {

  it('New-LocalUser creates a basic user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "TestUser" -NoPassword');
    const users = await run(ps, 'Get-LocalUser -Name TestUser');
    expect(users).toContain('TestUser');
  });

  it('New-LocalUser with password (plain text allowed in simulator?)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 
      '$pw = ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force; New-LocalUser -Name "UserWithPw" -Password $pw'
    );
    const output = await run(ps, 'Get-LocalUser -Name UserWithPw');
    expect(output).toContain('UserWithPw');
  });

  it('New-LocalUser fails with duplicate name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "DupUser" -NoPassword');
    const result = await run(ps, 'New-LocalUser -Name "DupUser" -NoPassword -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  it.skip('Remove-LocalUser deletes a user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "RemoveMe" -NoPassword');
    await run(ps, 'Remove-LocalUser -Name RemoveMe');
    const check = await run(ps, 'Get-LocalUser -Name RemoveMe -ErrorAction SilentlyContinue');
    expect(check).toContain('User not found');
  });

  it('Get-LocalUser lists all users', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-LocalUser');
    expect(output).toContain('Administrator');
    expect(output).toContain('Guest');
  });

  it('Get-LocalUser with -Name returns properties', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "PropUser" -NoPassword');
    const output = await run(ps, 'Get-LocalUser -Name PropUser | Select-Object -ExpandProperty Name');
    expect(output.trim()).toBe('PropUser');
  });

  it('Set-LocalUser changes account description', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "DescUser" -NoPassword');
    await run(ps, 'Set-LocalUser -Name DescUser -Description "Test Account"');
    const descOut = await run(ps, '(Get-LocalUser -Name DescUser).Description');
    expect(descOut.trim()).toBe('Test Account');
  });

  it.skip('Set-LocalUser enables and disables accounts', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "ToggleUser" -NoPassword');
    await run(ps, 'Set-LocalUser -Name ToggleUser -AccountDisabled');
    const disabledCheck = await run(ps, '(Get-LocalUser -Name ToggleUser).Enabled');
    expect(disabledCheck.trim()).toBe('False');
    await run(ps, 'Set-LocalUser -Name ToggleUser -AccountDisabled:$false');
    const enabledCheck = await run(ps, '(Get-LocalUser -Name ToggleUser).Enabled');
    expect(enabledCheck.trim()).toBe('True');
  });

  it.skip('Rename-LocalUser changes the user name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "OldName" -NoPassword');
    await run(ps, 'Rename-LocalUser -Name OldName -NewName NewName');
    const old = await run(ps, 'Get-LocalUser -Name OldName -ErrorAction SilentlyContinue');
    expect(old).toContain('User not found');
    const newU = await run(ps, 'Get-LocalUser -Name NewName -ErrorAction SilentlyContinue');
    expect(newU).toContain('NewName');
  });

  it.skip('should deny creating a user with a weak password according to local policy', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await run(ps, 
      '$pw = ConvertTo-SecureString "1" -AsPlainText -Force; New-LocalUser -Name "WeakPw" -Password $pw -ErrorAction SilentlyContinue'
    );
    expect(result).toContain('password does not meet');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. LOCAL GROUP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('3. Local Group Management', () => {

  it('New-LocalGroup creates a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalGroup -Name "TestGroup"');
    const groups = await run(ps, 'Get-LocalGroup -Name TestGroup');
    expect(groups).toContain('TestGroup');
  });

  it.skip('Remove-LocalGroup deletes a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalGroup -Name "TempGroup"');
    await run(ps, 'Remove-LocalGroup -Name TempGroup');
    const check = await run(ps, 'Get-LocalGroup -Name TempGroup -ErrorAction SilentlyContinue');
    expect(check).toContain('Group not found');
  });

  it('Add-LocalGroupMember adds a user to a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "MemberUser" -NoPassword');
    await run(ps, 'New-LocalGroup -Name "MyGroup"');
    await run(ps, 'Add-LocalGroupMember -Group MyGroup -Member MemberUser');
    const members = await run(ps, 'Get-LocalGroupMember -Group MyGroup');
    expect(members).toContain('MemberUser');
  });

  it('Remove-LocalGroupMember removes a user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "LeaveUser" -NoPassword');
    await run(ps, 'New-LocalGroup -Name "LeaveGroup"');
    await run(ps, 'Add-LocalGroupMember -Group LeaveGroup -Member LeaveUser');
    await run(ps, 'Remove-LocalGroupMember -Group LeaveGroup -Member LeaveUser');
    const members = await run(ps, 'Get-LocalGroupMember -Group LeaveGroup');
    expect(members).not.toContain('LeaveUser');
  });

  it('Get-LocalGroupMember returns all members of a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalUser -Name "UserA" -NoPassword');
    await run(ps, 'New-LocalUser -Name "UserB" -NoPassword');
    await run(ps, 'New-LocalGroup -Name "MultiGroup"');
    await run(ps, 'Add-LocalGroupMember -Group MultiGroup -Member UserA, UserB');
    const out = await run(ps, 'Get-LocalGroupMember -Group MultiGroup');
    expect(out).toContain('UserA');
    expect(out).toContain('UserB');
  });

  it.skip('should deny adding non-existent user to group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-LocalGroup -Name "ErrorGroup"');
    const result = await run(ps, 
      'Add-LocalGroupMember -Group ErrorGroup -Member GhostUser -ErrorAction SilentlyContinue'
    );
    expect(result).toContain('Cannot find user');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. DISKS & VOLUMES
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Disks & Volumes (Simulated)', () => {

  it('Get-Disk lists physical disks', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-Disk');
    expect(output).toContain('Number');
    expect(output).toContain('Size');
  });

  it('Get-Volume lists all volumes', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-Volume');
    expect(output).toContain('DriveLetter');
    expect(output).toContain('C');
  });

  it('Get-PSDrive lists drives including C: and D:', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-PSDrive');
    expect(output).toContain('C');
    expect(output).toContain('D');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. REGISTRY OPERATIONS (if simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe('5. Registry Operations', () => {

  it('New-Item creates a registry key', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path HKCU:\\Software\\TestSim -Force');
    const exists = await run(ps, 'Test-Path HKCU:\\Software\\TestSim');
    expect(exists.trim()).toBe('True');
  });

  it('Set-ItemProperty writes a value', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path HKCU:\\Software\\RegWrite -Force');
    await run(ps, 'Set-ItemProperty -Path HKCU:\\Software\\RegWrite -Name MyValue -Value 42 -Type DWord');
    const val = await run(ps, 'Get-ItemProperty -Path HKCU:\\Software\\RegWrite -Name MyValue');
    expect(val).toContain('42');
  });

  it('Remove-Item deletes a registry key', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path HKCU:\\Software\\RegDel -Force');
    await run(ps, 'Remove-Item -Path HKCU:\\Software\\RegDel');
    const exists = await run(ps, 'Test-Path HKCU:\\Software\\RegDel');
    expect(exists.trim()).toBe('False');
  });

  it('Get-ItemProperty fetches default property', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Get-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(out).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Environment Variables', () => {

  it.skip('Get-ChildItem Env: lists environment variables', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-ChildItem Env:');
    expect(output).toContain('Path');
    expect(output).toContain('SystemRoot');
  });

  it('$env: variable retrieval', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, '$env:SystemRoot');
    expect(out.trim()).toBe('C:\\Windows');
  });

  it.skip('[Environment]::SetEnvironmentVariable changes machine-level variable', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 
      '[System.Environment]::SetEnvironmentVariable("TEST_MACHINE", "1", "Machine")'
    );
    const val = await run(ps, 
      '[System.Environment]::GetEnvironmentVariable("TEST_MACHINE", "Machine")'
    );
    expect(val.trim()).toBe('1');
    // cleanup
    await run(ps, 
      '[System.Environment]::SetEnvironmentVariable("TEST_MACHINE", $null, "Machine")'
    );
  });

  it.skip('Set-Item with Env: drive persists variable for session', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Item -Path Env:TEMPTEST -Value "session"');
    const val = await run(ps, '$env:TEMPTEST');
    expect(val.trim()).toBe('session');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SERVICES (if simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Service Management', () => {

  it('Get-Service lists services', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-Service');
    expect(output).toContain('Status');
    expect(output).toContain('Name');
    // typical service in simulated environment
    expect(output).toContain('Spooler');
  });

  it('Get-Service -Name displays specific service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await run(ps, 'Get-Service -Name Spooler');
    expect(output).toContain('Spooler');
  });

  it('Start-Service starts a stopped service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // simulate a service that is currently stopped like 'bthserv'
    await run(ps, 'Stop-Service -Name bthserv -ErrorAction SilentlyContinue');
    await run(ps, 'Start-Service -Name bthserv');
    const status = await run(ps, '(Get-Service -Name bthserv).Status');
    expect(status.trim()).toBe('Running');
  });

  it('Stop-Service stops a running service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Start-Service -Name bthserv');
    await run(ps, 'Stop-Service -Name bthserv');
    const status = await run(ps, '(Get-Service -Name bthserv).Status');
    expect(status.trim()).toBe('Stopped');
  });

  it('Restart-Service restarts a service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Start-Service -Name bthserv');
    const before = await run(ps, '(Get-Service -Name bthserv).Status');
    expect(before.trim()).toBe('Running');
    await run(ps, 'Restart-Service -Name bthserv');
    const after = await run(ps, '(Get-Service -Name bthserv).Status');
    expect(after.trim()).toBe('Running');
  });

  it('Set-Service changes startup type', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Set-Service -Name bthserv -StartupType Manual');
    const startType = await run(ps, '(Get-Service -Name bthserv).StartType');
    expect(startType.trim()).toBe('Manual');
    // revert for other tests
    await run(ps, 'Set-Service -Name bthserv -StartupType Automatic');
  });

  it('should deny stopping a critical service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await run(ps, 'Stop-Service -Name winlogon -ErrorAction SilentlyContinue');
    expect(result).toContain('Cannot stop');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. NETWORK RELATED (simulated commands)
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Network Cmdlets', () => {

  it('Test-Connection sends one ping and returns success', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Test-Connection localhost -Count 1');
    expect(out).toContain('Source');
    expect(out).toContain('Destination');
  });

  it('Resolve-DnsName resolves a hostname', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Resolve-DnsName localhost');
    expect(out).toContain('127.0.0.1');
  });

  it.skip('Get-NetIPAddress shows IP configuration', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Get-NetIPAddress');
    expect(out).toContain('IPAddress');
    expect(out).toContain('InterfaceAlias');
  });

  it('Get-NetAdapter lists network adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Get-NetAdapter');
    expect(out).toContain('Name');
    expect(out).toContain('Status');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. SCHEDULED TASKS (if simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe('9. Scheduled Tasks', () => {

  it('Get-ScheduledTask lists tasks', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 'Get-ScheduledTask');
    expect(out).toContain('TaskName');
  });

  it('New-ScheduledTaskTrigger and Register-ScheduledTask', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const actionOut = await run(ps, 
      'Register-ScheduledTask -TaskName "SimTestTask" -Action (New-ScheduledTaskAction -Execute "calc.exe") -Trigger (New-ScheduledTaskTrigger -Daily -At "09:00") -Force'
    );
    expect(actionOut).toContain('SimTestTask');
    // unregister afterwards
    await run(ps, 'Unregister-ScheduledTask -TaskName SimTestTask -Confirm:$false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. PERMISSIONS – ACL / GET-ACL / SET-ACL
// ═══════════════════════════════════════════════════════════════════════════

describe('10. ACL & Permissions', () => {

  it.skip('Get-Acl on a file returns access control entries', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\aclfile.txt -ItemType File -Force');
    const acl = await run(ps, 'Get-Acl C:\\aclfile.txt');
    expect(acl).toContain('FileSystemRights');
    expect(acl).toContain('AccessControlType');
  });

  it('Set-Acl applies a new ACL entry (simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\aclset.txt -ItemType File -Force');
    // create a rule that denies BUILTIN\Users write
    await run(ps, `
      $acl = Get-Acl C:\\aclset.txt
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Users", "Write", "Deny")
      $acl.SetAccessRule($rule)
      Set-Acl -Path C:\\aclset.txt -AclObject $acl
    `);
    const aclOut = await run(ps, 'Get-Acl C:\\aclset.txt');
    expect(aclOut).toContain('Deny');
    expect(aclOut).toContain('Users');
  });

  it.skip('should deny access to a file protected by ACL', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'New-Item -Path C:\\secret.txt -ItemType File -Value "top secret"');
    // remove all permissions and add only Administrators:FullControl
    await run(ps, `
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators","FullControl","Allow")
      $acl.AddAccessRule($rule)
      Set-Acl C:\\secret.txt $acl
    `);
    // Change to a non-admin user and try to read
    pc.setCurrentUser('StandardUser');
    const result = await run(ps, 'Get-Content C:\\secret.txt -ErrorAction SilentlyContinue');
    expect(result).toContain('Access to the path');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. PIPELINES & SCRIPTING STATE CHANGES
// ═══════════════════════════════════════════════════════════════════════════

describe('11. Pipelines & Scripting State Changes', () => {

  it('Pipeline that creates multiple files from array', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 
      '"fileA.txt","fileB.txt","fileC.txt" | ForEach-Object { New-Item -Path "C:\\$($_)" -ItemType File }'
    );
    const a = await run(ps, 'Test-Path C:\\fileA.txt');
    expect(a.trim()).toBe('True');
    const b = await run(ps, 'Test-Path C:\\fileB.txt');
    expect(b.trim()).toBe('True');
  });

  it('Script that creates a user and adds them to a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const script = `
      $user = "ScriptUser"
      $group = "ScriptGroup"
      New-LocalUser -Name $user -NoPassword
      New-LocalGroup -Name $group
      Add-LocalGroupMember -Group $group -Member $user
    `;
    await run(ps, script);

    const memberOut = await run(ps, `Get-LocalGroupMember -Group ScriptGroup`);
    expect(memberOut).toContain('ScriptUser');
  });

  it('Function that adds a prefix to file content', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, `
      function PrependPrefix { param($Path,$Prefix) (Get-Content $Path) | ForEach-Object { "$Prefix$_" } | Set-Content $Path }
      Set-Content C:\\log.txt "line1","line2"
      PrependPrefix -Path C:\\log.txt -Prefix "[LOG] "
    `);
    const content = await run(ps, 'Get-Content C:\\log.txt');
    expect(content).toContain('[LOG] line1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ERROR HANDLING & $Error
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Error Handling & Automatic Variables', () => {
  it.skip('$Error contains last error after non‑terminating error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await run(ps, 'Get-Item C:\\NoExist -ErrorAction SilentlyContinue');
    const err = await run(ps, '$Error[0].Exception.Message');
    expect(err).toContain('Cannot find path');
  });

  it.skip('try/catch catches file not found and writes custom error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await run(ps, 
      'try { Get-Content C:\\ghost.txt -ErrorAction Stop } catch { Write-Output "Handled: $($_.Exception.Message)" }'
    );
    expect(out).toContain('Handled:');
  });
});
