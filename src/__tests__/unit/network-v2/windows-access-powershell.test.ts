/**
 * TDD Tests for Windows Access Control & Privilege Management — PowerShell
 *
 * Tests the Windows user/group/privilege system through PowerShell cmdlets:
 *   - Get-LocalUser, New-LocalUser, Set-LocalUser, Remove-LocalUser
 *   - Enable-LocalUser, Disable-LocalUser
 *   - Get-LocalGroup, New-LocalGroup, Remove-LocalGroup
 *   - Add-LocalGroupMember, Remove-LocalGroupMember, Get-LocalGroupMember
 *   - Get-Acl
 *   - whoami (also works in PS)
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
// GET-LOCALUSER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Get-LocalUser', () => {
  it('should list all local users in table format', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalUser');
    expect(output).toContain('Name');
    expect(output).toContain('Enabled');
    expect(output).toContain('Administrator');
    expect(output).toContain('Guest');
    expect(output).toContain('User');
  });

  it('should show details of a specific user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalUser -Name Administrator');
    expect(output).toContain('Administrator');
    expect(output).toContain('Enabled');
  });

  it('should return error for non-existent user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalUser -Name FakeUser');
    expect(output).toContain('was not found');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NEW-LOCALUSER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: New-LocalUser', () => {
  it('should create a new user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalUser -Name "PSUser" -Password "P@ssw0rd"');
    expect(output).toContain('PSUser');

    const list = await ps.execute('Get-LocalUser');
    expect(list).toContain('PSUser');
  });

  it('should create user with description', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "PSUser" -Password "P@ss" -Description "Test account"');
    const details = await ps.execute('Get-LocalUser -Name PSUser');
    expect(details).toContain('Test account');
  });

  it('should reject creating duplicate user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalUser -Name "Administrator" -Password "test"');
    expect(output).toContain('already exists');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalUser -Name "Hacker" -Password "pass"');
    expect(output).toContain('Access is denied');
  });

  it('should create user with -NoPassword switch', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalUser -Name "NoPassUser" -NoPassword');
    expect(output).toContain('NoPassUser');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SET-LOCALUSER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Set-LocalUser', () => {
  it('should change user description', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "PSUser" -Password "P@ss"');
    await ps.execute('Set-LocalUser -Name "PSUser" -Description "Updated desc"');
    const details = await ps.execute('Get-LocalUser -Name PSUser');
    expect(details).toContain('Updated desc');
  });

  it('should change user password', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "PSUser" -Password "OldPass"');
    const output = await ps.execute('Set-LocalUser -Name "PSUser" -Password "NewPass"');
    expect(output).not.toContain('error');
  });

  it('should change user full name', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "PSUser" -Password "P@ss"');
    await ps.execute('Set-LocalUser -Name "PSUser" -FullName "PS Test User"');
    const details = await ps.execute('Get-LocalUser -Name PSUser');
    expect(details).toContain('PS Test User');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Set-LocalUser -Name "Guest" -Description "hacked"');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// REMOVE-LOCALUSER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Remove-LocalUser', () => {
  it('should remove an existing user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "ToDelete" -Password "P@ss"');
    const output = await ps.execute('Remove-LocalUser -Name "ToDelete"');
    expect(output).toBe('');

    const list = await ps.execute('Get-LocalUser');
    expect(list).not.toContain('ToDelete');
  });

  it('should return error for non-existent user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Remove-LocalUser -Name "Ghost"');
    expect(output).toContain('was not found');
  });

  it('should prevent removing built-in Administrator', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Remove-LocalUser -Name "Administrator"');
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Remove-LocalUser -Name "Guest"');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENABLE-LOCALUSER / DISABLE-LOCALUSER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Enable-LocalUser / Disable-LocalUser', () => {
  it('should enable a disabled user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Enable-LocalUser -Name "Guest"');
    expect(output).toBe('');

    const details = await ps.execute('Get-LocalUser -Name Guest');
    expect(details).toContain('True');
  });

  it('should disable an enabled user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('Enable-LocalUser -Name "Guest"');
    const output = await ps.execute('Disable-LocalUser -Name "Guest"');
    expect(output).toBe('');

    const details = await ps.execute('Get-LocalUser -Name Guest');
    expect(details).toContain('False');
  });

  it('should return error for non-existent user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Enable-LocalUser -Name "Phantom"');
    expect(output).toContain('was not found');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Enable-LocalUser -Name "Guest"');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET-LOCALGROUP
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Get-LocalGroup', () => {
  it('should list all local groups', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalGroup');
    expect(output).toContain('Name');
    expect(output).toContain('Administrators');
    expect(output).toContain('Users');
    expect(output).toContain('Guests');
  });

  it('should show details of a specific group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalGroup -Name "Administrators"');
    expect(output).toContain('Administrators');
    expect(output).toContain('Description');
  });

  it('should return error for non-existent group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalGroup -Name "FakeGroup"');
    expect(output).toContain('was not found');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NEW-LOCALGROUP / REMOVE-LOCALGROUP
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: New-LocalGroup / Remove-LocalGroup', () => {
  it('should create a new group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalGroup -Name "DevTeam"');
    expect(output).toContain('DevTeam');

    const list = await ps.execute('Get-LocalGroup');
    expect(list).toContain('DevTeam');
  });

  it('should create group with description', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalGroup -Name "DevTeam" -Description "Development team"');
    const details = await ps.execute('Get-LocalGroup -Name "DevTeam"');
    expect(details).toContain('Development team');
  });

  it('should delete a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalGroup -Name "ToDelete"');
    const output = await ps.execute('Remove-LocalGroup -Name "ToDelete"');
    expect(output).toBe('');
  });

  it('should prevent deleting built-in groups', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Remove-LocalGroup -Name "Administrators"');
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('should require admin for group creation', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('New-LocalGroup -Name "Hackers"');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ADD-LOCALGROUPMEMBER / REMOVE-LOCALGROUPMEMBER / GET-LOCALGROUPMEMBER
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: LocalGroupMember cmdlets', () => {
  it('should list members of a group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalGroupMember -Group "Administrators"');
    expect(output).toContain('Administrator');
    expect(output).toContain('Name');
    expect(output).toContain('ObjectClass');
  });

  it('should add a member to a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "NewMember" -Password "P@ss"');
    const output = await ps.execute('Add-LocalGroupMember -Group "Administrators" -Member "NewMember"');
    expect(output).toBe('');

    const members = await ps.execute('Get-LocalGroupMember -Group "Administrators"');
    expect(members).toContain('NewMember');
  });

  it('should remove a member from a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "TempMember" -Password "P@ss"');
    await ps.execute('Add-LocalGroupMember -Group "Administrators" -Member "TempMember"');
    const output = await ps.execute('Remove-LocalGroupMember -Group "Administrators" -Member "TempMember"');
    expect(output).toBe('');

    const members = await ps.execute('Get-LocalGroupMember -Group "Administrators"');
    expect(members).not.toContain('TempMember');
  });

  it('should reject adding non-existent user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Add-LocalGroupMember -Group "Users" -Member "Ghost"');
    expect(output).toContain('was not found');
  });

  it('should reject adding duplicate member', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('Add-LocalGroupMember -Group "Administrators" -Member "Administrator"');
    expect(output).toContain('already a member');
  });

  it('should return error for non-existent group', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalGroupMember -Group "FakeGroup"');
    expect(output).toContain('was not found');
  });

  it('should require admin privileges for add', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Add-LocalGroupMember -Group "Administrators" -Member "User"');
    expect(output).toContain('Access is denied');
  });

  it('should require admin privileges for remove', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Remove-LocalGroupMember -Group "Users" -Member "User"');
    expect(output).toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET-ACL
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: Get-Acl', () => {
  it('should show ACL for a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await pc.executeCommand('echo test > testfile.txt');
    const output = await ps.execute('Get-Acl testfile.txt');
    expect(output).toContain('Path');
    expect(output).toContain('Owner');
    expect(output).toContain('Access');
  });

  it('should show ACL for a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await pc.executeCommand('mkdir TestDir');
    const output = await ps.execute('Get-Acl TestDir');
    expect(output).toContain('Path');
    expect(output).toContain('Owner');
  });

  it('should return error for non-existent path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Acl nonexistent');
    expect(output).toContain('Cannot find path');
  });

  it('should support -Path parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await pc.executeCommand('echo data > myfile.txt');
    const output = await ps.execute('Get-Acl -Path myfile.txt');
    expect(output).toContain('Owner');
  });
});

// ═══════════════════════════════════════════════════════════════════
// WHOAMI IN POWERSHELL
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: whoami', () => {
  it('should display current user in PowerShell context', async () => {
    const pc = createPC('DESKTOP-PS');
    const ps = createPS(pc);
    const output = await ps.execute('whoami');
    expect(output!.toLowerCase()).toContain('desktop-ps\\user');
  });

  it('should reflect user switch', async () => {
    const pc = createPC('MYPC');
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('whoami');
    expect(output!.toLowerCase()).toContain('mypc\\administrator');
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('PowerShell: access control edge cases', () => {
  it('should handle case-insensitive cmdlet names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('get-localuser');
    expect(output).toContain('Administrator');
  });

  it('should handle case-insensitive user names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const output = await ps.execute('Get-LocalUser -Name "administrator"');
    expect(output).toContain('Administrator');
  });

  it('should handle $env:USERNAME reflecting current user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    const output = await ps.execute('$env:USERNAME');
    expect(output).toContain('Administrator');
  });

  it('should handle multiple operations in sequence', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const ps = createPS(pc);
    await ps.execute('New-LocalUser -Name "User1" -Password "P@ss"');
    await ps.execute('New-LocalUser -Name "User2" -Password "P@ss"');
    await ps.execute('New-LocalGroup -Name "Team"');
    await ps.execute('Add-LocalGroupMember -Group "Team" -Member "User1"');
    await ps.execute('Add-LocalGroupMember -Group "Team" -Member "User2"');

    const members = await ps.execute('Get-LocalGroupMember -Group "Team"');
    expect(members).toContain('User1');
    expect(members).toContain('User2');
  });
});
