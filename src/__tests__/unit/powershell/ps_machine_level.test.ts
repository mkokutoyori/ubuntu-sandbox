// ═══════════════════════════════════════════════════════════════════════════
// machine-state.test.ts — PowerShell machine‑level integration tests
// ═══════════════════════════════════════════════════════════════════════════
// These tests execute real PowerShell scripts on a simulated Windows PC
// and verify that the state of the machine (files, users, groups, etc.)
// changes as expected.

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
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

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FILE SYSTEM – DIRECTORIES & FILES
// ═══════════════════════════════════════════════════════════════════════════

describe('1. File System – Directories & Files', () => {

  // 1.1 New-Item – directories
  it('New-Item creates a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\TestDir -ItemType Directory');
    const exists = await ps.execute('Test-Path C:\\TestDir');
    expect(exists.trim()).toBe('True');
  });

  it('New-Item creates an empty file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\empty.txt -ItemType File');
    const content = await ps.execute('Get-Content C:\\empty.txt');
    expect(content.trim()).toBe('');
  });

  it('New-Item with -Value writes content', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\greet.txt -ItemType File -Value "hello world"');
    const content = await ps.execute('Get-Content C:\\greet.txt');
    expect(content.trim()).toBe('hello world');
  });

  it('New-Item throws on duplicate directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\dup -ItemType Directory');
    const result = await ps.execute('New-Item -Path C:\\dup -ItemType Directory -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  // 1.2 Get-Content / Set-Content / Add-Content
  it('Set-Content overwrites file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\data.txt -Value "first"');
    await ps.execute('Set-Content -Path C:\\data.txt -Value "second"');
    const content = await ps.execute('Get-Content C:\\data.txt');
    expect(content.trim()).toBe('second');
  });

  it('Add-Content appends to file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\log.txt -Value "line1"');
    await ps.execute('Add-Content -Path C:\\log.txt -Value "line2"');
    const content = await ps.execute('Get-Content C:\\log.txt');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it('Get-Content with -Tail returns last lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const tail = await ps.execute('Get-Content C:\\numbers.txt -Tail 2');
    const lines = tail.split(/\r?\n/).filter(l => l !== '');
    expect(lines).toEqual(['4', '5']);
  });

  it('Get-Content with -TotalCount returns first lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"a","b","c" | Set-Content C:\\abc.txt');
    const head = await ps.execute('Get-Content C:\\abc.txt -TotalCount 2');
    const lines = head.split(/\r?\n/).filter(l => l !== '');
    expect(lines).toEqual(['a', 'b']);
  });

  // 1.3 Copy-Item / Move-Item / Remove-Item
  it('Copy-Item duplicates a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\orig.txt -Value "original"');
    await ps.execute('Copy-Item -Path C:\\orig.txt -Destination C:\\copy.txt');
    const content = await ps.execute('Get-Content C:\\copy.txt');
    expect(content.trim()).toBe('original');
  });

  it('Copy-Item can copy to a different drive', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\source.txt -Value "data"');
    await ps.execute('Copy-Item C:\\source.txt D:\\backup.txt');
    const content = await ps.execute('Get-Content D:\\backup.txt');
    expect(content.trim()).toBe('data');
  });

  it('Move-Item renames a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\oldname.txt -Value "content"');
    await ps.execute('Move-Item -Path C:\\oldname.txt -Destination C:\\newname.txt');
    const existsOld = await ps.execute('Test-Path C:\\oldname.txt');
    expect(existsOld.trim()).toBe('False');
    const content = await ps.execute('Get-Content C:\\newname.txt');
    expect(content.trim()).toBe('content');
  });

  it('Move-Item moves a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\FolderA -ItemType Directory');
    await ps.execute('Set-Content -Path C:\\FolderA\file.txt -Value "inside"');
    await ps.execute('Move-Item -Path C:\\FolderA -Destination C:\\FolderB');
    const content = await ps.execute('Get-Content C:\\FolderB\file.txt');
    expect(content.trim()).toBe('inside');
  });

  it('Remove-Item deletes a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\todel.txt -ItemType File');
    await ps.execute('Remove-Item C:\\todel.txt');
    const exists = await ps.execute('Test-Path C:\\todel.txt');
    expect(exists.trim()).toBe('False');
  });

  it('Remove-Item deletes a directory recursively', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\Dir -ItemType Directory');
    await ps.execute('New-Item -Path C:\\Dir\subfile.txt -ItemType File');
    await ps.execute('Remove-Item -Path C:\\Dir -Recurse');
    const exists = await ps.execute('Test-Path C:\\Dir');
    expect(exists.trim()).toBe('False');
  });

  // 1.4 Wildcards & recurse
  it('Get-ChildItem with -Filter returns matching files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\img -ItemType Directory');
    await ps.execute('New-Item -Path C:\\img\photo1.jpg -ItemType File');
    await ps.execute('New-Item -Path C:\\img\photo2.png -ItemType File');
    const jpgs = await ps.execute('Get-ChildItem C:\\img -Filter *.jpg');
    expect(jpgs).toContain('photo1.jpg');
    expect(jpgs).not.toContain('photo2.png');
  });

  it('Get-ChildItem -Recurse lists all files in subtree', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\tree\\level1\\level2 -ItemType Directory -Force');
    await ps.execute('Set-Content -Path C:\\tree\\level1\\level2\deep.txt -Value "deep"');
    const all = await ps.execute('Get-ChildItem -Path C:\\tree -Recurse');
    expect(all).toContain('deep.txt');
  });

  // 1.5 Resolve-Path & Join-Path
  it('Resolve-Path returns the fully qualified path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\resolve\\file.txt -ItemType File -Force');
    const resolved = await ps.execute('Resolve-Path C:\\resolve\\.\\file.txt');
    expect(resolved.trim()).toContain('C:\\resolve\\file.txt');
  });

  it('Join-Path constructs a valid path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Join-Path C:\\Users Document');
    expect(result.trim()).toBe('C:\\Users\\Document');
  });

  // 1.6 Clear-Content
  it('Clear-Content empties a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\clear.txt "data"');
    await ps.execute('Clear-Content C:\\clear.txt');
    const content = await ps.execute('Get-Content C:\\clear.txt');
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
    await ps.execute('New-LocalUser -Name "TestUser" -NoPassword');
    const users = await ps.execute('Get-LocalUser -Name TestUser');
    expect(users).toContain('TestUser');
  });

  it('New-LocalUser with password (plain text allowed in simulator?)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      '$pw = ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force; New-LocalUser -Name "UserWithPw" -Password $pw'
    );
    const output = await ps.execute('Get-LocalUser -Name UserWithPw');
    expect(output).toContain('UserWithPw');
  });

  it('New-LocalUser fails with duplicate name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "DupUser" -NoPassword');
    const result = await ps.execute('New-LocalUser -Name "DupUser" -NoPassword -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  it('Remove-LocalUser deletes a user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "RemoveMe" -NoPassword');
    await ps.execute('Remove-LocalUser -Name RemoveMe');
    const check = await ps.execute('Get-LocalUser -Name RemoveMe -ErrorAction SilentlyContinue');
    expect(check).toContain('User not found');
  });

  it('Get-LocalUser lists all users', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalUser');
    expect(output).toContain('Administrator');
    expect(output).toContain('Guest');
  });

  it('Get-LocalUser with -Name returns properties', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "PropUser" -NoPassword');
    const output = await ps.execute('Get-LocalUser -Name PropUser | Select-Object -ExpandProperty Name');
    expect(output.trim()).toBe('PropUser');
  });

  it('Set-LocalUser changes account description', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "DescUser" -NoPassword');
    await ps.execute('Set-LocalUser -Name DescUser -Description "Test Account"');
    const descOut = await ps.execute('(Get-LocalUser -Name DescUser).Description');
    expect(descOut.trim()).toBe('Test Account');
  });

  it('Set-LocalUser enables and disables accounts', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "ToggleUser" -NoPassword');
    await ps.execute('Set-LocalUser -Name ToggleUser -AccountDisabled');
    const disabledCheck = await ps.execute('(Get-LocalUser -Name ToggleUser).Enabled');
    expect(disabledCheck.trim()).toBe('False');
    await ps.execute('Set-LocalUser -Name ToggleUser -AccountDisabled:$false');
    const enabledCheck = await ps.execute('(Get-LocalUser -Name ToggleUser).Enabled');
    expect(enabledCheck.trim()).toBe('True');
  });

  it('Rename-LocalUser changes the user name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "OldName" -NoPassword');
    await ps.execute('Rename-LocalUser -Name OldName -NewName NewName');
    const old = await ps.execute('Get-LocalUser -Name OldName -ErrorAction SilentlyContinue');
    expect(old).toContain('User not found');
    const newU = await ps.execute('Get-LocalUser -Name NewName -ErrorAction SilentlyContinue');
    expect(newU).toContain('NewName');
  });

  it('should deny creating a user with a weak password according to local policy', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute(
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
    await ps.execute('New-LocalGroup -Name "TestGroup"');
    const groups = await ps.execute('Get-LocalGroup -Name TestGroup');
    expect(groups).toContain('TestGroup');
  });

  it('Remove-LocalGroup deletes a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalGroup -Name "TempGroup"');
    await ps.execute('Remove-LocalGroup -Name TempGroup');
    const check = await ps.execute('Get-LocalGroup -Name TempGroup -ErrorAction SilentlyContinue');
    expect(check).toContain('Group not found');
  });

  it('Add-LocalGroupMember adds a user to a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "MemberUser" -NoPassword');
    await ps.execute('New-LocalGroup -Name "MyGroup"');
    await ps.execute('Add-LocalGroupMember -Group MyGroup -Member MemberUser');
    const members = await ps.execute('Get-LocalGroupMember -Group MyGroup');
    expect(members).toContain('MemberUser');
  });

  it('Remove-LocalGroupMember removes a user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "LeaveUser" -NoPassword');
    await ps.execute('New-LocalGroup -Name "LeaveGroup"');
    await ps.execute('Add-LocalGroupMember -Group LeaveGroup -Member LeaveUser');
    await ps.execute('Remove-LocalGroupMember -Group LeaveGroup -Member LeaveUser');
    const members = await ps.execute('Get-LocalGroupMember -Group LeaveGroup');
    expect(members).not.toContain('LeaveUser');
  });

  it('Get-LocalGroupMember returns all members of a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "UserA" -NoPassword');
    await ps.execute('New-LocalUser -Name "UserB" -NoPassword');
    await ps.execute('New-LocalGroup -Name "MultiGroup"');
    await ps.execute('Add-LocalGroupMember -Group MultiGroup -Member UserA, UserB');
    const out = await ps.execute('Get-LocalGroupMember -Group MultiGroup');
    expect(out).toContain('UserA');
    expect(out).toContain('UserB');
  });

  it('should deny adding non-existent user to group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-LocalGroup -Name "ErrorGroup"');
    const result = await ps.execute(
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
    const output = await ps.execute('Get-Disk');
    expect(output).toContain('Number');
    expect(output).toContain('Size');
  });

  it('Get-Volume lists all volumes', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Volume');
    expect(output).toContain('DriveLetter');
    expect(output).toContain('C');
  });

  it('Get-PSDrive lists drives including C: and D:', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-PSDrive');
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
    await ps.execute('New-Item -Path HKCU:\\Software\\TestSim -Force');
    const exists = await ps.execute('Test-Path HKCU:\\Software\\TestSim');
    expect(exists.trim()).toBe('True');
  });

  it('Set-ItemProperty writes a value', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path HKCU:\\Software\\RegWrite -Force');
    await ps.execute('Set-ItemProperty -Path HKCU:\\Software\\RegWrite -Name MyValue -Value 42 -Type DWord');
    const val = await ps.execute('Get-ItemProperty -Path HKCU:\\Software\\RegWrite -Name MyValue');
    expect(val).toContain('42');
  });

  it('Remove-Item deletes a registry key', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path HKCU:\\Software\\RegDel -Force');
    await ps.execute('Remove-Item -Path HKCU:\\Software\\RegDel');
    const exists = await ps.execute('Test-Path HKCU:\\Software\\RegDel');
    expect(exists.trim()).toBe('False');
  });

  it('Get-ItemProperty fetches default property', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(out).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Environment Variables', () => {

  it('Get-ChildItem Env: lists environment variables', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-ChildItem Env:');
    expect(output).toContain('Path');
    expect(output).toContain('SystemRoot');
  });

  it('$env: variable retrieval', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('$env:SystemRoot');
    expect(out.trim()).toBe('C:\\Windows');
  });

  it('[Environment]::SetEnvironmentVariable changes machine-level variable', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      '[System.Environment]::SetEnvironmentVariable("TEST_MACHINE", "1", "Machine")'
    );
    const val = await ps.execute(
      '[System.Environment]::GetEnvironmentVariable("TEST_MACHINE", "Machine")'
    );
    expect(val.trim()).toBe('1');
    // cleanup
    await ps.execute(
      '[System.Environment]::SetEnvironmentVariable("TEST_MACHINE", $null, "Machine")'
    );
  });

  it('Set-Item with Env: drive persists variable for session', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Item -Path Env:TEMPTEST -Value "session"');
    const val = await ps.execute('$env:TEMPTEST');
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
    const output = await ps.execute('Get-Service');
    expect(output).toContain('Status');
    expect(output).toContain('Name');
    // typical service in simulated environment
    expect(output).toContain('spooler');
  });

  it('Get-Service -Name displays specific service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Service -Name spooler');
    expect(output).toContain('spooler');
  });

  it('Start-Service starts a stopped service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // simulate a service that is currently stopped like 'bthserv'
    await ps.execute('Stop-Service -Name bthserv -ErrorAction SilentlyContinue');
    await ps.execute('Start-Service -Name bthserv');
    const status = await ps.execute('(Get-Service -Name bthserv).Status');
    expect(status.trim()).toBe('Running');
  });

  it('Stop-Service stops a running service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Start-Service -Name bthserv');
    await ps.execute('Stop-Service -Name bthserv');
    const status = await ps.execute('(Get-Service -Name bthserv).Status');
    expect(status.trim()).toBe('Stopped');
  });

  it('Restart-Service restarts a service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Start-Service -Name bthserv');
    const before = await ps.execute('(Get-Service -Name bthserv).Status');
    expect(before.trim()).toBe('Running');
    await ps.execute('Restart-Service -Name bthserv');
    const after = await ps.execute('(Get-Service -Name bthserv).Status');
    expect(after.trim()).toBe('Running');
  });

  it('Set-Service changes startup type', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Service -Name bthserv -StartupType Manual');
    const startType = await ps.execute('(Get-Service -Name bthserv).StartType');
    expect(startType.trim()).toBe('Manual');
    // revert for other tests
    await ps.execute('Set-Service -Name bthserv -StartupType Automatic');
  });

  it('should deny stopping a critical service', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Stop-Service -Name winlogon -ErrorAction SilentlyContinue');
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
    const out = await ps.execute('Test-Connection localhost -Count 1');
    expect(out).toContain('Source');
    expect(out).toContain('Destination');
  });

  it('Resolve-DnsName resolves a hostname', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Resolve-DnsName localhost');
    expect(out).toContain('127.0.0.1');
  });

  it('Get-NetIPAddress shows IP configuration', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('IPAddress');
    expect(out).toContain('InterfaceAlias');
  });

  it('Get-NetAdapter lists network adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter');
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
    const out = await ps.execute('Get-ScheduledTask');
    expect(out).toContain('TaskName');
  });

  it('New-ScheduledTaskTrigger and Register-ScheduledTask', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const actionOut = await ps.execute(
      'Register-ScheduledTask -TaskName "SimTestTask" -Action (New-ScheduledTaskAction -Execute "calc.exe") -Trigger (New-ScheduledTaskTrigger -Daily -At "09:00") -Force'
    );
    expect(actionOut).toContain('SimTestTask');
    // unregister afterwards
    await ps.execute('Unregister-ScheduledTask -TaskName SimTestTask -Confirm:$false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. PERMISSIONS – ACL / GET-ACL / SET-ACL
// ═══════════════════════════════════════════════════════════════════════════

describe('10. ACL & Permissions', () => {

  it('Get-Acl on a file returns access control entries', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\aclfile.txt -ItemType File -Force');
    const acl = await ps.execute('Get-Acl C:\\aclfile.txt');
    expect(acl).toContain('FileSystemRights');
    expect(acl).toContain('AccessControlType');
  });

  it('Set-Acl applies a new ACL entry (simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\aclset.txt -ItemType File -Force');
    // create a rule that denies BUILTIN\Users write
    await ps.execute(`
      $acl = Get-Acl C:\\aclset.txt
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Users", "Write", "Deny")
      $acl.SetAccessRule($rule)
      Set-Acl -Path C:\\aclset.txt -AclObject $acl
    `);
    const aclOut = await ps.execute('Get-Acl C:\\aclset.txt');
    expect(aclOut).toContain('Deny');
    expect(aclOut).toContain('Users');
  });

  it('should deny access to a file protected by ACL', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\secret.txt -ItemType File -Value "top secret"');
    // remove all permissions and add only Administrators:FullControl
    await ps.execute(`
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators","FullControl","Allow")
      $acl.AddAccessRule($rule)
      Set-Acl C:\\secret.txt $acl
    `);
    // Change to a non-admin user and try to read
    pc.setCurrentUser('StandardUser');
    const result = await ps.execute('Get-Content C:\\secret.txt -ErrorAction SilentlyContinue');
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
    await ps.execute(
      '"fileA.txt","fileB.txt","fileC.txt" | ForEach-Object { New-Item -Path "C:\\$($_)" -ItemType File }'
    );
    const a = await ps.execute('Test-Path C:\\fileA.txt');
    expect(a.trim()).toBe('True');
    const b = await ps.execute('Test-Path C:\\fileB.txt');
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
    await ps.execute(script);

    const memberOut = await ps.execute(`Get-LocalGroupMember -Group ScriptGroup`);
    expect(memberOut).toContain('ScriptUser');
  });

  it('Function that adds a prefix to file content', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(`
      function PrependPrefix { param($Path,$Prefix) (Get-Content $Path) | ForEach-Object { "$Prefix$_" } | Set-Content $Path }
      Set-Content C:\\log.txt "line1","line2"
      PrependPrefix -Path C:\\log.txt -Prefix "[LOG] "
    `);
    const content = await ps.execute('Get-Content C:\\log.txt');
    expect(content).toContain('[LOG] line1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ERROR HANDLING & $Error
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Error Handling & Automatic Variables', () => {
  it('$Error contains last error after non‑terminating error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Get-Item C:\\NoExist -ErrorAction SilentlyContinue');
    const err = await ps.execute('$Error[0].Exception.Message');
    expect(err).toContain('Cannot find path');
  });

  it('try/catch catches file not found and writes custom error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute(
      'try { Get-Content C:\\ghost.txt -ErrorAction Stop } catch { Write-Output "Handled: $($_.Exception.Message)" }'
    );
    expect(out).toContain('Handled:');
  });
});
