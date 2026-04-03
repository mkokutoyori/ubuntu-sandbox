/**
 * TDD Tests for Windows Access Control & Privilege Management — CMD
 *
 * Tests the Windows user/group/privilege system through CMD commands:
 *   - whoami (with /priv, /groups, /all, /user)
 *   - net user (list, add, delete, modify, view)
 *   - net localgroup (list, add/remove members, create/delete)
 *   - runas /user:xxx command
 *   - icacls (view, grant, deny, remove ACLs)
 *   - Privilege enforcement (admin-only commands blocked for standard users)
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
// WHOAMI COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('CMD: whoami', () => {
  it('should display current username with hostname prefix', async () => {
    const pc = createPC('DESKTOP-01');
    const output = await pc.executeCommand('whoami');
    expect(output.toLowerCase()).toContain('desktop-01\\user');
  });

  it('should display user SID with /user flag', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('whoami /user');
    expect(output).toContain('SID');
    expect(output).toMatch(/S-1-5-21-/);
  });

  it('should display group memberships with /groups flag', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('whoami /groups');
    expect(output).toContain('Users');
    expect(output).toContain('GROUP INFORMATION');
  });

  it('should display privileges with /priv flag', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('whoami /priv');
    expect(output).toContain('PRIVILEGES INFORMATION');
    expect(output).toContain('SeShutdownPrivilege');
  });

  it('should display all information with /all flag', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('whoami /all');
    expect(output).toContain('USER INFORMATION');
    expect(output).toContain('GROUP INFORMATION');
    expect(output).toContain('PRIVILEGES INFORMATION');
  });

  it('should show admin privileges when user is Administrator', async () => {
    const pc = createPC();
    // Switch to Administrator context
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('whoami /priv');
    expect(output).toContain('SeDebugPrivilege');
    expect(output).toContain('SeTakeOwnershipPrivilege');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NET USER COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('CMD: net user — list users', () => {
  it('should list all local users', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user');
    expect(output).toContain('Administrator');
    expect(output).toContain('Guest');
    expect(output).toContain('User');
  });
});

describe('CMD: net user — view user details', () => {
  it('should show details for Administrator', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Administrator');
    expect(output).toContain('User name');
    expect(output).toContain('Administrator');
    expect(output).toContain('Full Name');
    expect(output).toContain('Account active');
    expect(output).toContain('Local Group Memberships');
    expect(output).toContain('Administrators');
  });

  it('should show details for Guest account', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Guest');
    expect(output).toContain('Guest');
    expect(output).toContain('Account active');
    expect(output).toContain('No');
  });

  it('should return error for non-existent user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user NonExistent');
    expect(output).toContain('The user name could not be found');
  });
});

describe('CMD: net user — add user', () => {
  it('should create a new user with password', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user TestUser P@ssw0rd /add');
    expect(output).toContain('The command completed successfully');

    const list = await pc.executeCommand('net user');
    expect(list).toContain('TestUser');
  });

  it('should reject creating an existing user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Administrator P@ss /add');
    expect(output).toContain('already exists');
  });

  it('should require admin privileges to add a user', async () => {
    const pc = createPC();
    // Default user is "User" (non-admin)
    const output = await pc.executeCommand('net user TestUser P@ss /add');
    expect(output).toContain('Access is denied');
  });
});

describe('CMD: net user — delete user', () => {
  it('should delete an existing user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    const output = await pc.executeCommand('net user TestUser /delete');
    expect(output).toContain('The command completed successfully');

    const list = await pc.executeCommand('net user');
    expect(list).not.toContain('TestUser');
  });

  it('should return error when deleting non-existent user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Ghost /delete');
    expect(output).toContain('The user name could not be found');
  });

  it('should prevent deleting the built-in Administrator', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Administrator /delete');
    expect(output.toLowerCase()).toContain('cannot');
  });
});

describe('CMD: net user — modify user', () => {
  it('should activate a disabled account', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user Guest /active:yes');
    expect(output).toContain('The command completed successfully');

    const details = await pc.executeCommand('net user Guest');
    expect(details).toContain('Yes');
  });

  it('should deactivate an account', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user Guest /active:yes');
    const output = await pc.executeCommand('net user Guest /active:no');
    expect(output).toContain('The command completed successfully');
  });

  it('should change user password', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser OldPass /add');
    const output = await pc.executeCommand('net user TestUser NewPass');
    expect(output).toContain('The command completed successfully');
  });

  it('should set full name with /fullname', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    await pc.executeCommand('net user TestUser /fullname:"Test User"');
    const details = await pc.executeCommand('net user TestUser');
    expect(details).toContain('Test User');
  });

  it('should set comment with /comment', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    await pc.executeCommand('net user TestUser /comment:"A test account"');
    const details = await pc.executeCommand('net user TestUser');
    expect(details).toContain('A test account');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NET LOCALGROUP COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('CMD: net localgroup — list groups', () => {
  it('should list all local groups', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup');
    expect(output).toContain('Administrators');
    expect(output).toContain('Users');
    expect(output).toContain('Guests');
  });
});

describe('CMD: net localgroup — view group members', () => {
  it('should list members of Administrators group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup Administrators');
    expect(output).toContain('Administrator');
    expect(output).toContain('Members');
  });

  it('should return error for non-existent group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup FakeGroup');
    expect(output).toContain('could not be found');
  });
});

describe('CMD: net localgroup — create/delete groups', () => {
  it('should create a new group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup DevTeam /add');
    expect(output).toContain('The command completed successfully');

    const list = await pc.executeCommand('net localgroup');
    expect(list).toContain('DevTeam');
  });

  it('should delete a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net localgroup DevTeam /add');
    const output = await pc.executeCommand('net localgroup DevTeam /delete');
    expect(output).toContain('The command completed successfully');
  });

  it('should prevent deleting built-in groups', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup Administrators /delete');
    expect(output.toLowerCase()).toContain('cannot');
  });

  it('should require admin privileges', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net localgroup TestGroup /add');
    expect(output).toContain('Access is denied');
  });
});

describe('CMD: net localgroup — add/remove members', () => {
  it('should add a user to a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    const output = await pc.executeCommand('net localgroup Administrators TestUser /add');
    expect(output).toContain('The command completed successfully');

    const members = await pc.executeCommand('net localgroup Administrators');
    expect(members).toContain('TestUser');
  });

  it('should remove a user from a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    await pc.executeCommand('net localgroup Administrators TestUser /add');
    const output = await pc.executeCommand('net localgroup Administrators TestUser /delete');
    expect(output).toContain('The command completed successfully');

    const members = await pc.executeCommand('net localgroup Administrators');
    expect(members).not.toContain('TestUser');
  });

  it('should reject adding non-existent user to a group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup Administrators Ghost /add');
    expect(output).toContain('could not be found');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RUNAS COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('CMD: runas command', () => {
  it('should switch user context with correct password', async () => {
    const pc = createPC();
    // runas changes current user for subsequent commands
    const output = await pc.executeCommand('runas /user:Administrator whoami');
    // runas in our simulation prompts for password; we expose setCurrentUser
    // For non-interactive simulation, runas validates and switches
    expect(output.toLowerCase()).toContain('administrator');
  });

  it('should reject with wrong credentials', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('runas /user:NonExistent whoami');
    expect(output).toContain('is not recognized');
  });

  it('should show usage when arguments are missing', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('runas');
    expect(output).toMatch(/usage|syntax/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ICACLS COMMAND
// ═══════════════════════════════════════════════════════════════════

describe('CMD: icacls — view permissions', () => {
  it('should show ACLs for a file', async () => {
    const pc = createPC();
    await pc.executeCommand('echo test > testfile.txt');
    const output = await pc.executeCommand('icacls testfile.txt');
    expect(output).toContain('testfile.txt');
    // Default should show owner having full control
    expect(output).toMatch(/BUILTIN\\Users|NT AUTHORITY|BUILTIN\\Administrators/);
  });

  it('should show ACLs for a directory', async () => {
    const pc = createPC();
    await pc.executeCommand('mkdir TestDir');
    const output = await pc.executeCommand('icacls TestDir');
    expect(output).toContain('TestDir');
  });

  it('should return error for non-existent path', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('icacls nonexistent');
    expect(output).toContain('The system cannot find the file specified');
  });
});

describe('CMD: icacls — grant permissions', () => {
  it('should grant read permission to a user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('echo test > testfile.txt');
    const output = await pc.executeCommand('icacls testfile.txt /grant User:(R)');
    expect(output).toContain('Successfully processed');

    const acl = await pc.executeCommand('icacls testfile.txt');
    expect(acl).toContain('User');
    expect(acl).toContain('R');
  });

  it('should grant full control to a user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('echo test > testfile.txt');
    const output = await pc.executeCommand('icacls testfile.txt /grant TestUser:(F)');
    expect(output).toContain('Successfully processed');

    const acl = await pc.executeCommand('icacls testfile.txt');
    expect(acl).toContain('F');
  });

  it('should require admin to modify ACLs', async () => {
    const pc = createPC();
    await pc.executeCommand('echo test > testfile.txt');
    const output = await pc.executeCommand('icacls testfile.txt /grant Guest:(R)');
    expect(output).toContain('Access is denied');
  });
});

describe('CMD: icacls — deny permissions', () => {
  it('should deny write permission to a user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('echo test > testfile.txt');
    const output = await pc.executeCommand('icacls testfile.txt /deny Guest:(W)');
    expect(output).toContain('Successfully processed');

    const acl = await pc.executeCommand('icacls testfile.txt');
    expect(acl).toContain('Guest');
    expect(acl).toContain('DENY');
  });
});

describe('CMD: icacls — remove permissions', () => {
  it('should remove all permissions for a user', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('echo test > testfile.txt');
    await pc.executeCommand('icacls testfile.txt /grant Guest:(R)');
    const output = await pc.executeCommand('icacls testfile.txt /remove Guest');
    expect(output).toContain('Successfully processed');

    const acl = await pc.executeCommand('icacls testfile.txt');
    expect(acl).not.toContain('Guest');
  });
});

// ═══════════════════════════════════════════════════════════════════
// PRIVILEGE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

describe('CMD: privilege enforcement', () => {
  it('should allow standard user to run whoami', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('whoami');
    expect(output).not.toContain('Access is denied');
  });

  it('should deny net user /add for standard user', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net user Hacker pass /add');
    expect(output).toContain('Access is denied');
  });

  it('should deny net localgroup /add for standard user', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net localgroup Hackers /add');
    expect(output).toContain('Access is denied');
  });

  it('should deny net user /delete for standard user', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net user Guest /delete');
    expect(output).toContain('Access is denied');
  });

  it('should allow admin to run all net commands', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net user NewUser P@ss /add');
    expect(output).toContain('The command completed successfully');
  });

  it('should allow standard user to view net user list', async () => {
    const pc = createPC();
    const output = await pc.executeCommand('net user');
    expect(output).toContain('User');
    expect(output).not.toContain('Access is denied');
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('CMD: access control edge cases', () => {
  it('should handle case-insensitive usernames', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('net user TestUser P@ss /add');
    const output = await pc.executeCommand('net user testuser');
    expect(output).toContain('TestUser');
  });

  it('should handle case-insensitive group names', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('net localgroup administrators');
    expect(output).toContain('Administrator');
  });

  it('should handle whoami case-insensitively after user switch', async () => {
    const pc = createPC('MY-PC');
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('whoami');
    expect(output.toLowerCase()).toContain('my-pc\\administrator');
  });

  it('should reflect new user in environment after setCurrentUser', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    const output = await pc.executeCommand('set USERNAME');
    expect(output).toContain('Administrator');
  });

  it('should not allow adding duplicate user to group', async () => {
    const pc = createPC();
    pc.setCurrentUser('Administrator');
    // Administrator is already in Administrators group
    const output = await pc.executeCommand('net localgroup Administrators Administrator /add');
    expect(output).toContain('already a member');
  });
});
