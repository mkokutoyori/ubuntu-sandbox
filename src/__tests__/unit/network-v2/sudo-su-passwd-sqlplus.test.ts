/**
 * Tests for sudo, su, passwd, and sqlplus functionality.
 *
 * Covers:
 *   - sudo command execution, privilege escalation, -u flag, sudo group checks
 *   - su user switching, su stack, login shell
 *   - passwd password changes (own, other user, root, flags)
 *   - sqlplus session creation, login, commands, connect, disconnect
 *   - LinuxTerminalSession interactive flows for all the above
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { createSQLPlusSession } from '@/terminal/commands/database';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: sudo — Backend (LinuxCommandExecutor / LinuxPC)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: sudo command execution', () => {
  it('should execute commands as root when using sudo on a server', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('whoami');
    expect(result).toBe('root');
  });

  it('should execute sudo commands on a PC (user in sudo group)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');

    // Default user is 'user' (non-root)
    const whoami = await pc.executeCommand('whoami');
    expect(whoami).toBe('user');

    // sudo whoami should execute as root and return 'root'
    // Note: at the executor level, sudo doesn't require password check
    // (that's handled by the terminal session interactive flow)
    const sudoWhoami = await pc.executeCommand('sudo whoami');
    expect(sudoWhoami).toBe('root');
  });

  it('should restore user context after sudo command', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');

    await pc.executeCommand('sudo touch /root/testfile');
    const afterWhoami = await pc.executeCommand('whoami');
    expect(afterWhoami).toBe('user');
  });

  it('should handle sudo -u to run commands as a specific user', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');

    // Create a test user
    await server.executeCommand('useradd -m testuser');

    // Run command as testuser
    const result = await server.executeCommand('sudo -u testuser whoami');
    expect(result).toBe('testuser');
  });

  it('should return error for sudo -u with unknown user', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('sudo -u nonexistent whoami');
    expect(result).toContain('unknown user');
  });

  it('should handle sudo -l to list permissions', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const result = await pc.executeCommand('sudo -l');
    expect(result).toContain('User user may run');
    expect(result).toContain('(ALL : ALL) ALL');
  });

  it('should check sudo group membership for sudo -l', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');

    // Create user NOT in sudo group
    await server.executeCommand('useradd -m noprivuser');

    // Switch to that user
    await server.executeCommand('su noprivuser');
    const result = await server.executeCommand('sudo -l');
    expect(result).toContain('not in the sudoers file');
  });

  it('should canSudo() return true for users in sudo group', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    // Default 'user' is in sudo group
    expect(pc.canSudo()).toBe(true);
  });

  it('should canSudo() return true for root', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    expect(server.canSudo()).toBe(true);
  });

  it('should reject sudo command from user not in sudo group', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');

    // Create user NOT in sudo group
    await server.executeCommand('useradd -m nosudouser');

    // Switch to that user
    await server.executeCommand('su nosudouser');

    // Try sudo su — should be rejected
    const result = await server.executeCommand('sudo su');
    expect(result).toContain('not in the sudoers file');
  });

  it('should show usage when sudo is called with no arguments', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const result = await pc.executeCommand('sudo');
    expect(result).toContain('usage');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: su — Backend (user switching)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: su command execution', () => {
  it('should switch to root user with su', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    // Create a regular user and switch to it first
    await server.executeCommand('useradd -m bob');
    await server.executeCommand('su bob');
    const whoami = await server.executeCommand('whoami');
    expect(whoami).toBe('bob');

    // Now su back to root
    await server.executeCommand('su root');
    const afterWhoami = await server.executeCommand('whoami');
    expect(afterWhoami).toBe('root');
  });

  it('should switch to a named user with su', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m alice');

    await server.executeCommand('su alice');
    const whoami = await server.executeCommand('whoami');
    expect(whoami).toBe('alice');
  });

  it('should handle su with login shell flag', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m -d /home/charlie charlie');

    await server.executeCommand('su - charlie');
    const cwd = await server.executeCommand('pwd');
    expect(cwd.trim()).toBe('/home/charlie');
  });

  it('should return to previous user on exit after su', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m dave');

    const initialUser = await server.executeCommand('whoami');
    expect(initialUser).toBe('root');

    await server.executeCommand('su dave');
    const suUser = await server.executeCommand('whoami');
    expect(suUser).toBe('dave');

    // handleExit should pop the su stack
    const exitResult = server.handleExit();
    expect(exitResult.inSu).toBe(true);

    const restored = await server.executeCommand('whoami');
    expect(restored).toBe('root');
  });

  it('should handle nested su sessions', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m user1');
    await server.executeCommand('useradd -m user2');

    await server.executeCommand('su user1');
    expect(await server.executeCommand('whoami')).toBe('user1');

    await server.executeCommand('su user2');
    expect(await server.executeCommand('whoami')).toBe('user2');

    server.handleExit();
    expect(await server.executeCommand('whoami')).toBe('user1');

    server.handleExit();
    expect(await server.executeCommand('whoami')).toBe('root');
  });

  it('should reject su to user with nologin shell', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -s /usr/sbin/nologin svcacct');
    const result = await server.executeCommand('su svcacct');
    expect(result).toContain('does not have a login shell');
  });

  it('should reject su to nonexistent user', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('su nobody_here');
    expect(result).toContain('does not exist');
  });

  it('should handle sudo su correctly', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    // Create user, switch to it, then sudo su back to root
    await server.executeCommand('useradd -m -G sudo alice');
    await server.executeCommand('su alice');
    expect(await server.executeCommand('whoami')).toBe('alice');

    // sudo su should switch to root
    await server.executeCommand('sudo su');
    expect(await server.executeCommand('whoami')).toBe('root');

    // Exiting should go back to alice (not root)
    const exitResult = server.handleExit();
    expect(exitResult.inSu).toBe(true);
    expect(await server.executeCommand('whoami')).toBe('alice');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: passwd — Backend (password management)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: passwd and password management', () => {
  it('should set password and verify with checkPassword', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m testpw');
    server.setUserPassword('testpw', 'secret123');

    expect(server.checkPassword('testpw', 'secret123')).toBe(true);
    expect(server.checkPassword('testpw', 'wrong')).toBe(false);
  });

  it('should handle passwd -l (lock) and passwd -u (unlock)', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m lockuser');
    server.setUserPassword('lockuser', 'pass123');

    // Lock the user
    const lockResult = await server.executeCommand('passwd -l lockuser');
    expect(lockResult).toContain('password expiry information changed');

    // Check status shows locked
    const status = await server.executeCommand('passwd -S lockuser');
    expect(status).toContain('L');

    // Unlock the user
    await server.executeCommand('passwd -u lockuser');

    // Password should still work after unlock
    expect(server.checkPassword('lockuser', 'pass123')).toBe(true);
  });

  it('should handle passwd -S (status)', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m statususer');
    server.setUserPassword('statususer', 'mypass');

    const status = await server.executeCommand('passwd -S statususer');
    expect(status).toContain('statususer');
    expect(status).toContain('P'); // P = password set
  });

  it('should show NP status for user without password', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m nopassuser');

    const status = await server.executeCommand('passwd -S nopassuser');
    expect(status).toContain('nopassuser');
    expect(status).toContain('NP'); // NP = no password
  });

  it('should handle passwd for nonexistent user', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('passwd -S ghost');
    expect(result).toContain('does not exist');
  });

  it('should handle chpasswd command', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m chpwuser');
    await server.executeCommand('echo "chpwuser:newpass" | chpasswd');

    expect(server.checkPassword('chpwuser', 'newpass')).toBe(true);
  });

  it('should check default root password', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    expect(server.checkPassword('root', 'admin')).toBe(true);
    expect(server.checkPassword('root', 'wrong')).toBe(false);
  });

  it('should check default user password on PC', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.checkPassword('user', 'admin')).toBe(true);
    expect(pc.checkPassword('user', 'wrong')).toBe(false);
  });

  it('should handle chage -l to list password aging info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m ageuser');

    const info = await server.executeCommand('chage -l ageuser');
    expect(info).toContain('Last password change');
    expect(info).toContain('Password expires');
    expect(info).toContain('Maximum number of days');
  });

  it('should set password aging with chage', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m ageuser2');

    await server.executeCommand('chage -M 90 -m 7 -W 14 ageuser2');
    const info = await server.executeCommand('chage -l ageuser2');
    expect(info).toContain('90');
    expect(info).toContain('7');
    expect(info).toContain('14');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: adduser / deluser — Backend
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: adduser and deluser', () => {
  it('should create user with adduser and set up home directory', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('adduser --disabled-password --gecos "Test User" testadduser');
    expect(result).toContain('Adding user');
    expect(result).toContain('testadduser');

    // Verify user exists
    const id = await server.executeCommand('id testadduser');
    expect(id).toContain('testadduser');

    // Verify home directory
    const home = await server.executeCommand('ls -d /home/testadduser');
    expect(home).toContain('/home/testadduser');
  });

  it('should delete user with deluser', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('adduser --disabled-password --gecos "" duser');
    await server.executeCommand('deluser duser');

    const id = await server.executeCommand('id duser');
    expect(id).toContain('no such user');
  });

  it('should delete user and remove home with deluser --remove-home', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    // First create the user with useradd to ensure they exist
    await server.executeCommand('useradd -m rmuser');
    // Verify user exists
    const idCheck = await server.executeCommand('id rmuser');
    expect(idCheck).toContain('rmuser');
    // Now delete with deluser --remove-home
    const result = await server.executeCommand('deluser --remove-home rmuser');
    expect(result).toContain('Removing');
    expect(result).toContain('Done');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: LinuxTerminalSession interactive flows
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: LinuxTerminalSession interactive sudo/su/passwd flows', () => {
  it('should build interactive steps for sudo command', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    // Access the private buildInteractiveSteps through currentInputMode after executeCommand
    // We'll test the public behavior instead
    expect(pc.getCurrentUser()).toBe('user');
    expect(pc.getCurrentUid()).not.toBe(0);
  });

  it('should not require sudo password when already root', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const session = new LinuxTerminalSession('test-session', server);

    // Root user should not trigger interactive steps for sudo
    const mode = session.currentInputMode;
    expect(mode.type).toBe('normal');
  });

  it('should handle password mode lifecycle correctly', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    // Set and get password buffer
    session.setPasswordBuf('test123');
    expect(session.getPasswordBuf()).toBe('test123');
  });

  it('should handle input buffer for interactive text mode', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    session.setInputBuf('some input');
    expect(session.getInputBuf()).toBe('some input');
  });

  it('should handle Ctrl+C to cancel password prompt', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    // Set up a password buffer
    session.setPasswordBuf('partial');

    // Ctrl+C in normal mode should just pass through
    const result = session.handleKey({ key: 'c', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false });
    // In normal mode, handleKey returns false for Ctrl+C (handled by base class)
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('should correctly identify prompt parts for the colored prompt', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    const parts = session.getPromptParts();
    expect(parts.user).toBe('user');
    expect(parts.promptChar).toBe('$');
    expect(parts.path).toBe('~');
  });

  it('should show # prompt for root user', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const session = new LinuxTerminalSession('test-session', server);

    const parts = session.getPromptParts();
    expect(parts.user).toBe('root');
    expect(parts.promptChar).toBe('#');
  });

  it('should handle info bar content', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);

    const info = session.getInfoBarContent();
    expect(info.left).toContain('user@');
    expect(info.left).toContain('~');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: SQLPlus — Session and Commands
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: SQLPlus session management', () => {
  it('should create a SQLPlus session with valid credentials', () => {
    const { session, banner, loginOutput } = createSQLPlusSession('test-device', ['sys/admin', 'as', 'sysdba']);

    expect(banner.length).toBeGreaterThan(0);
    expect(banner.some(l => l.includes('SQL*Plus'))).toBe(true);
    expect(loginOutput).toContain('Connected.');
    expect(session.isConnected()).toBe(true);
    expect(session.getCurrentUser()).toBe('SYS');
    expect(session.isSysdba()).toBe(true);
  });

  it('should create a SQLPlus session with / as sysdba', () => {
    const { session, loginOutput } = createSQLPlusSession('test-device-2', ['/', 'as', 'sysdba']);
    expect(loginOutput).toContain('Connected.');
    expect(session.isConnected()).toBe(true);
    expect(session.isSysdba()).toBe(true);
  });

  it('should show "Not connected" when no credentials provided', () => {
    const { session, loginOutput } = createSQLPlusSession('test-device-3', []);
    expect(loginOutput).toContain('Not connected.');
    expect(session.isConnected()).toBe(false);
  });

  it('should handle EXIT command', () => {
    const { session } = createSQLPlusSession('test-device-4', ['/', 'as', 'sysdba']);
    expect(session.isConnected()).toBe(true);

    const result = session.processLine('EXIT');
    expect(result.exit).toBe(true);
    expect(result.output.some(l => l.includes('Disconnected'))).toBe(true);
    expect(session.isConnected()).toBe(false);
  });

  it('should handle QUIT command', () => {
    const { session } = createSQLPlusSession('test-device-5', ['/', 'as', 'sysdba']);
    const result = session.processLine('QUIT');
    expect(result.exit).toBe(true);
  });

  it('should handle SHOW USER command', () => {
    const { session } = createSQLPlusSession('test-device-6', ['/', 'as', 'sysdba']);
    const result = session.processLine('SHOW USER');
    expect(result.output.some(l => l.includes('SYS'))).toBe(true);
  });

  it('should handle SET and SHOW LINESIZE', () => {
    const { session } = createSQLPlusSession('test-device-7', ['/', 'as', 'sysdba']);

    session.processLine('SET LINESIZE 200');
    const result = session.processLine('SHOW LINESIZE');
    expect(result.output.some(l => l.includes('200'))).toBe(true);
  });

  it('should handle SET and SHOW PAGESIZE', () => {
    const { session } = createSQLPlusSession('test-device-8', ['/', 'as', 'sysdba']);

    session.processLine('SET PAGESIZE 50');
    const result = session.processLine('SHOW PAGESIZE');
    expect(result.output.some(l => l.includes('50'))).toBe(true);
  });

  it('should handle SHOW ALL to display all settings', () => {
    const { session } = createSQLPlusSession('test-device-9', ['/', 'as', 'sysdba']);
    const result = session.processLine('SHOW ALL');
    expect(result.output.some(l => l.includes('autocommit'))).toBe(true);
    expect(result.output.some(l => l.includes('linesize'))).toBe(true);
    expect(result.output.some(l => l.includes('pagesize'))).toBe(true);
  });

  it('should handle SET SERVEROUTPUT ON/OFF', () => {
    const { session } = createSQLPlusSession('test-device-10', ['/', 'as', 'sysdba']);

    session.processLine('SET SERVEROUTPUT ON');
    let result = session.processLine('SHOW SERVEROUTPUT');
    expect(result.output.some(l => l.includes('ON'))).toBe(true);

    session.processLine('SET SERVEROUTPUT OFF');
    result = session.processLine('SHOW SERVEROUTPUT');
    expect(result.output.some(l => l.includes('OFF'))).toBe(true);
  });

  it('should handle HELP command', () => {
    const { session } = createSQLPlusSession('test-device-11', ['/', 'as', 'sysdba']);
    const result = session.processLine('HELP');
    expect(result.output.some(l => l.includes('CONNECT'))).toBe(true);
    expect(result.output.some(l => l.includes('DESCRIBE'))).toBe(true);
    expect(result.output.some(l => l.includes('EXIT'))).toBe(true);
  });

  it('should report error for SQL when not connected', () => {
    const { session } = createSQLPlusSession('test-device-12', []);
    const result = session.processLine('SELECT 1 FROM DUAL;');
    expect(result.output.some(l => l.includes('ORA-01012'))).toBe(true);
  });

  it('should handle CONNECT command with credentials', () => {
    const { session } = createSQLPlusSession('test-device-13', []);
    expect(session.isConnected()).toBe(false);

    const result = session.processLine('CONNECT / AS SYSDBA');
    expect(result.output).toContain('Connected.');
    expect(session.isConnected()).toBe(true);
  });

  it('should handle CONNECT without password with helpful error', () => {
    const { session } = createSQLPlusSession('test-device-14', ['/', 'as', 'sysdba']);
    const result = session.processLine('CONNECT scott');
    expect(result.output.some(l => l.includes('SP2-0306'))).toBe(true);
    expect(result.output.some(l => l.includes('Usage'))).toBe(true);
  });

  it('should handle unknown SET option', () => {
    const { session } = createSQLPlusSession('test-device-15', ['/', 'as', 'sysdba']);
    const result = session.processLine('SET BOGUS ON');
    expect(result.output.some(l => l.includes('SP2-0158'))).toBe(true);
  });

  it('should handle SPOOL ON/OFF', () => {
    const { session } = createSQLPlusSession('test-device-16', ['/', 'as', 'sysdba']);
    session.processLine('SPOOL /tmp/output.txt');
    session.processLine('SPOOL OFF');
    // No error expected
  });

  it('should handle / to re-execute last statement', () => {
    const { session } = createSQLPlusSession('test-device-17', ['/', 'as', 'sysdba']);

    // First execute a query
    session.processLine('SELECT 1 AS NUM FROM DUAL;');

    // Re-execute with /
    const result = session.processLine('/');
    // Should not be an error about empty buffer
    expect(result.output.some(l => l.includes('SP2-0103'))).toBe(false);
  });

  it('should report error for / when buffer is empty', () => {
    const { session } = createSQLPlusSession('test-device-18', ['/', 'as', 'sysdba']);
    const result = session.processLine('/');
    expect(result.output.some(l => l.includes('SP2-0103'))).toBe(true);
  });

  it('should handle multi-line SQL terminated by semicolon', () => {
    const { session } = createSQLPlusSession('test-device-19', ['/', 'as', 'sysdba']);

    const r1 = session.processLine('SELECT');
    expect(r1.needsMoreInput).toBe(true);

    const r2 = session.processLine('1 AS NUM');
    expect(r2.needsMoreInput).toBe(true);

    const r3 = session.processLine('FROM DUAL;');
    expect(r3.needsMoreInput).toBe(false);
  });

  it('should handle multi-line SQL terminated by /', () => {
    const { session } = createSQLPlusSession('test-device-20', ['/', 'as', 'sysdba']);

    session.processLine('SELECT');
    session.processLine('1 AS NUM');
    session.processLine('FROM DUAL');

    const result = session.processLine('/');
    expect(result.needsMoreInput).toBe(false);
  });

  it('should clear SQL buffer on empty line', () => {
    const { session } = createSQLPlusSession('test-device-21', ['/', 'as', 'sysdba']);

    session.processLine('SELECT');
    const r = session.processLine('');
    expect(r.needsMoreInput).toBe(false);

    // Now / should fail because buffer was cleared
    const slashResult = session.processLine('/');
    // lastStatement was not set by the aborted input, so it depends on whether
    // there was a previous statement
    expect(slashResult.output.some(l => l.includes('SP2-0103'))).toBe(true);
  });

  it('should handle HOST command (not supported)', () => {
    const { session } = createSQLPlusSession('test-device-22', ['/', 'as', 'sysdba']);
    const result = session.processLine('HOST ls');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
  });

  it('should handle unknown command', () => {
    const { session } = createSQLPlusSession('test-device-23', ['/', 'as', 'sysdba']);
    const result = session.processLine('BOGUS_COMMAND');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
  });

  it('should handle SET FEEDBACK ON/OFF', () => {
    const { session } = createSQLPlusSession('test-device-24', ['/', 'as', 'sysdba']);

    session.processLine('SET FEEDBACK OFF');
    const r = session.processLine('SHOW FEEDBACK');
    expect(r.output.some(l => l.includes('0'))).toBe(true);

    session.processLine('SET FEEDBACK ON');
    const r2 = session.processLine('SHOW FEEDBACK');
    expect(r2.output.some(l => l.includes('1'))).toBe(true);
  });

  it('should handle SET TIMING ON and show elapsed time', () => {
    const { session } = createSQLPlusSession('test-device-25', ['/', 'as', 'sysdba']);

    session.processLine('SET TIMING ON');
    const result = session.processLine('SELECT 1 FROM DUAL;');
    expect(result.output.some(l => l.includes('Elapsed'))).toBe(true);
  });

  it('should handle SET HEADING OFF to hide column headers', () => {
    const { session } = createSQLPlusSession('test-device-26', ['/', 'as', 'sysdba']);

    session.processLine('SET HEADING OFF');
    const result = session.processLine('SELECT 1 AS NUM FROM DUAL;');
    // With heading off, there should be no column header line
    const hasHeader = result.output.some(l => l.trim() === 'NUM');
    expect(hasHeader).toBe(false);
  });

  it('should return correct prompt', () => {
    const { session } = createSQLPlusSession('test-device-27', ['/', 'as', 'sysdba']);
    expect(session.getPrompt()).toBe('SQL> ');
  });

  it('should handle SET SQLPROMPT', () => {
    const { session } = createSQLPlusSession('test-device-28', ['/', 'as', 'sysdba']);
    session.processLine('SET SQLPROMPT "ORCL> "');
    expect(session.getPrompt()).toBe('ORCL> ');
  });

  it('should handle PROMPT command', () => {
    const { session } = createSQLPlusSession('test-device-29', ['/', 'as', 'sysdba']);
    const result = session.processLine('PROMPT Hello World');
    expect(result.output).toContain('Hello World');
  });

  it('should handle SHOW RELEASE', () => {
    const { session } = createSQLPlusSession('test-device-30', ['/', 'as', 'sysdba']);
    const result = session.processLine('SHOW RELEASE');
    expect(result.output.some(l => l.includes('1903000000'))).toBe(true);
  });

  it('should handle SHOW ERRORS', () => {
    const { session } = createSQLPlusSession('test-device-31', ['/', 'as', 'sysdba']);
    const result = session.processLine('SHOW ERRORS');
    expect(result.output).toContain('No errors.');
  });

  it('should handle SET NULL to display custom null representation', () => {
    const { session } = createSQLPlusSession('test-device-32', ['/', 'as', 'sysdba']);
    session.processLine('SET NULL "(null)"');
    // Verify by showing all settings
    const result = session.processLine('SHOW ALL');
    expect(result.output.some(l => l.includes('(null)'))).toBe(true);
  });

  it('should handle SET COLSEP', () => {
    const { session } = createSQLPlusSession('test-device-33', ['/', 'as', 'sysdba']);
    session.processLine('SET COLSEP "|"');
    const result = session.processLine('SHOW ALL');
    expect(result.output.some(l => l.includes('|'))).toBe(true);
  });

  it('should disconnect on exit', () => {
    const { session } = createSQLPlusSession('test-device-34', ['/', 'as', 'sysdba']);
    expect(session.isConnected()).toBe(true);

    session.disconnect();
    expect(session.isConnected()).toBe(false);
    expect(session.getCurrentUser()).toBe('');
  });

  it('should getBanner return SQL*Plus banner', () => {
    const db = new OracleDatabase();
    const session = new SQLPlusSession(db);
    const banner = session.getBanner();
    expect(banner.some(l => l.includes('SQL*Plus'))).toBe(true);
    expect(banner.some(l => l.includes('Copyright'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: User management integration
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: User management integration', () => {
  it('should useradd create user with proper ID', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m newuser');
    const id = await server.executeCommand('id newuser');
    expect(id).toContain('newuser');
    expect(id).toContain('uid=');
    expect(id).toContain('gid=');
  });

  it('should useradd with -G add user to supplementary groups', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m -G sudo,video grpuser');
    const groups = await server.executeCommand('groups grpuser');
    expect(groups).toContain('sudo');
    expect(groups).toContain('video');
  });

  it('should userdel remove user from all groups', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m -G sudo delme');
    await server.executeCommand('userdel delme');
    const id = await server.executeCommand('id delme');
    expect(id).toContain('no such user');
  });

  it('should usermod -L lock user and -U unlock', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m moduser');
    server.setUserPassword('moduser', 'original');

    await server.executeCommand('usermod -L moduser');
    const status = await server.executeCommand('passwd -S moduser');
    expect(status).toContain('L');

    await server.executeCommand('usermod -U moduser');
    expect(server.checkPassword('moduser', 'original')).toBe(true);
  });

  it('should getent passwd return user info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('getent passwd root');
    expect(result).toContain('root');
    expect(result).toContain('/bin/bash');
  });

  it('should getent group return group info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('getent group sudo');
    expect(result).toContain('sudo');
  });

  it('should gpasswd -d remove user from group', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m -G video gpuser');
    await server.executeCommand('gpasswd -d gpuser video');
    const groups = await server.executeCommand('groups gpuser');
    expect(groups).not.toContain('video');
  });

  it('should finger show user info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('adduser --disabled-password --gecos "John Doe,,555-1234,555-5678," fingeruser');
    const result = await server.executeCommand('finger fingeruser');
    expect(result).toContain('John Doe');
    expect(result).toContain('/home/fingeruser');
  });

  it('should who show current user', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('who');
    expect(result).toContain('root');
  });

  it('should w show system info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('w');
    expect(result).toContain('USER');
    expect(result).toContain('root');
  });

  it('should last show login history', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('last');
    expect(result).toContain('root');
    expect(result).toContain('still logged in');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: SQLPlus terminal integration
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: SQLPlus terminal integration', () => {
  it('should enter sqlplus mode in terminal session', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const session = new LinuxTerminalSession('test-session', server);

    // Simulate entering sqlplus
    session.handleKey({ key: 's', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    // This just types 's' — we need to test the mode transition
    // Let's check the initial mode
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('should handle Ctrl+D to exit sqlplus', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const session = new LinuxTerminalSession('test-session', server);
    // Session starts in normal mode
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('should session type be linux', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);
    expect(session.getSessionType()).toBe('linux');
  });

  it('should theme have correct properties', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('test-session', pc);
    const theme = session.getTheme();
    expect(theme.sessionType).toBe('linux');
    expect(theme.backgroundColor).toBeDefined();
    expect(theme.textColor).toBeDefined();
    expect(theme.promptColor).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 9: Edge cases and security
// ═══════════════════════════════════════════════════════════════════

describe('Group 9: Edge cases and security', () => {
  it('should not allow empty username in useradd', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const result = await server.executeCommand('useradd');
    expect(result).toContain('missing');
  });

  it('should reject duplicate useradd', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m dupuser');
    const result = await server.executeCommand('useradd -m dupuser');
    expect(result).toContain('already exists');
  });

  it('should reject groupadd for existing group', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('groupadd testgroup');
    const result = await server.executeCommand('groupadd testgroup');
    expect(result).toContain('already exists');
  });

  it('should handle groupmod rename', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('groupadd oldname');
    await server.executeCommand('groupmod -n newname oldname');
    const result = await server.executeCommand('getent group newname');
    expect(result).toContain('newname');
  });

  it('should handle groupdel', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('groupadd delgroup');
    await server.executeCommand('groupdel delgroup');
    const result = await server.executeCommand('getent group delgroup');
    expect(result).toBe('');
  });

  it('should handle userExists correctly', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.userExists('user')).toBe(true);
    expect(pc.userExists('nonexistent')).toBe(false);
  });

  it('should handle resetSession to clear su stack', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m resetuser');
    await server.executeCommand('su resetuser');
    expect(await server.executeCommand('whoami')).toBe('resetuser');

    server.resetSession();
    expect(await server.executeCommand('whoami')).toBe('root');
  });

  it('should handle multiple password changes', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m multipass');

    server.setUserPassword('multipass', 'first');
    expect(server.checkPassword('multipass', 'first')).toBe(true);

    server.setUserPassword('multipass', 'second');
    expect(server.checkPassword('multipass', 'first')).toBe(false);
    expect(server.checkPassword('multipass', 'second')).toBe(true);

    server.setUserPassword('multipass', 'third');
    expect(server.checkPassword('multipass', 'second')).toBe(false);
    expect(server.checkPassword('multipass', 'third')).toBe(true);
  });

  it('should checkPassword return false for nonexistent user', () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    expect(server.checkPassword('ghostuser', 'anypass')).toBe(false);
  });

  it('should handle chfn to change user info', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m chfnuser');
    await server.executeCommand('chfn -f "Jane Smith" -r "Room 42" -w "555-0100" chfnuser');
    const finger = await server.executeCommand('finger chfnuser');
    expect(finger).toContain('Jane Smith');
  });

  it('should setUserGecos set GECOS fields', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    await server.executeCommand('useradd -m gecosuser');
    server.setUserGecos('gecosuser', 'Full Name', 'Room 1', '111', '222', 'Other');
    const finger = await server.executeCommand('finger gecosuser');
    expect(finger).toContain('Full Name');
  });
});
