/**
 * Tests for new Linux commands and Oracle utility tools.
 *
 * Covers: systemctl, service, df, du, free, mount, lsblk, top,
 *         ifconfig, netstat, ss, curl, wget, ping, apt, seq, etc.
 *         Oracle: expdp, impdp (Data Pump).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import {
  initOracleFilesystem,
  getOracleDatabase,
  resetAllOracleInstances,
} from '@/terminal/commands/database';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let server: LinuxServer;
let pc: LinuxPC;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  server = new LinuxServer('linux-server', 'OracleDB1');
  pc = new LinuxPC('linux-pc', 'Desktop1');
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: systemctl
// ═══════════════════════════════════════════════════════════════════

describe('systemctl', () => {

  it('systemctl status shows system running', async () => {
    const out = await server.executeCommand('systemctl status');
    expect(out).toContain('running');
  });

  it('systemctl status ssh shows service info', async () => {
    const out = await server.executeCommand('systemctl status ssh');
    expect(out).toContain('ssh.service');
    expect(out).toContain('OpenBSD Secure Shell');
    expect(out).toContain('active (running)');
  });

  it('systemctl status unknown-service shows not found', async () => {
    const out = await server.executeCommand('systemctl status foobar');
    expect(out).toContain('could not be found');
  });

  it('systemctl is-active ssh returns active', async () => {
    const out = await server.executeCommand('systemctl is-active ssh');
    expect(out.trim()).toBe('active');
  });

  it('systemctl is-enabled ssh returns enabled', async () => {
    const out = await server.executeCommand('systemctl is-enabled ssh');
    expect(out.trim()).toBe('enabled');
  });

  it('systemctl list-units shows services', async () => {
    const out = await server.executeCommand('systemctl list-units');
    expect(out).toContain('ssh.service');
    expect(out).toContain('cron.service');
    expect(out).toContain('loaded units listed');
  });

  it('systemctl enable creates symlink message', async () => {
    const out = await server.executeCommand('systemctl enable ssh');
    expect(out).toContain('Created symlink');
  });

  it('systemctl disable removes symlink', async () => {
    const out = await server.executeCommand('systemctl disable ssh');
    expect(out).toContain('Removed');
  });

  it('systemctl start/stop/restart return empty (success)', async () => {
    expect((await server.executeCommand('systemctl start ssh')).trim()).toBe('');
    expect((await server.executeCommand('systemctl stop ssh')).trim()).toBe('');
    expect((await server.executeCommand('systemctl restart ssh')).trim()).toBe('');
  });

  it('server shows oracle-ohasd service', async () => {
    const out = await server.executeCommand('systemctl list-units');
    expect(out).toContain('oracle-ohasd');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: service
// ═══════════════════════════════════════════════════════════════════

describe('service', () => {

  it('service --status-all lists all services', async () => {
    const out = await server.executeCommand('service --status-all');
    expect(out).toContain('ssh');
    expect(out).toContain('cron');
    expect(out).toMatch(/\[ [+-] \]/);
  });

  it('service ssh status shows running', async () => {
    const out = await server.executeCommand('service ssh status');
    expect(out).toContain('is running');
  });

  it('service unknown shows unrecognized', async () => {
    const out = await server.executeCommand('service foobar status');
    expect(out).toContain('unrecognized service');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: df, du, free
// ═══════════════════════════════════════════════════════════════════

describe('df', () => {

  it('df shows filesystem table', async () => {
    const out = await server.executeCommand('df');
    expect(out).toContain('/dev/sda1');
    expect(out).toContain('Mounted on');
  });

  it('df -h shows human-readable sizes', async () => {
    const out = await server.executeCommand('df -h');
    expect(out).toMatch(/\d+G/);
    expect(out).toContain('Size');
  });

  it('df -i shows inode info', async () => {
    const out = await server.executeCommand('df -i');
    expect(out).toContain('Inodes');
    expect(out).toContain('IUsed');
  });
});

describe('du', () => {

  it('du -sh shows summary', async () => {
    const out = await server.executeCommand('du -sh /root');
    expect(out).toContain('/root');
  });

  it('du on nonexistent dir shows error', async () => {
    const out = await server.executeCommand('du /nonexistent');
    expect(out).toContain('No such file or directory');
  });
});

describe('free', () => {

  it('free shows memory info', async () => {
    const out = await server.executeCommand('free');
    expect(out).toContain('Mem:');
    expect(out).toContain('Swap:');
    expect(out).toContain('total');
  });

  it('free -h shows human-readable', async () => {
    const out = await server.executeCommand('free -h');
    expect(out).toMatch(/\d+(\.\d+)?[GMK]i/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: mount, lsblk
// ═══════════════════════════════════════════════════════════════════

describe('mount', () => {

  it('mount with no args shows mounted filesystems', async () => {
    const out = await server.executeCommand('mount');
    expect(out).toContain('/dev/sda1 on /');
    expect(out).toContain('ext4');
    expect(out).toContain('/u01');
  });
});

describe('lsblk', () => {

  it('lsblk shows block devices', async () => {
    const out = await server.executeCommand('lsblk');
    expect(out).toContain('sda');
    expect(out).toContain('sdb');
    expect(out).toContain('disk');
    expect(out).toContain('part');
  });

  it('lsblk -f shows filesystem info', async () => {
    const out = await server.executeCommand('lsblk -f');
    expect(out).toContain('ext4');
    expect(out).toContain('FSTYPE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: top
// ═══════════════════════════════════════════════════════════════════

describe('top', () => {

  it('top shows process list with header', async () => {
    const out = await server.executeCommand('top -b -n 1');
    expect(out).toContain('top -');
    expect(out).toContain('PID');
    expect(out).toContain('COMMAND');
    expect(out).toContain('systemd');
    expect(out).toContain('MiB Mem');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Network commands
// ═══════════════════════════════════════════════════════════════════

describe('ifconfig', () => {

  it('ifconfig shows interfaces', async () => {
    const out = await server.executeCommand('ifconfig');
    // Should contain at least loopback or eth0
    expect(out).toMatch(/eth\d:/);
    expect(out).toContain('flags=');
    expect(out).toContain('mtu');
  });
});

describe('netstat', () => {

  it('netstat -tlnp shows listening ports', async () => {
    const out = await server.executeCommand('netstat -tlnp');
    expect(out).toContain(':22');
    expect(out).toContain('LISTEN');
  });

  it('netstat -r shows routing table', async () => {
    const out = await server.executeCommand('netstat -r');
    expect(out).toContain('Kernel IP routing table');
    expect(out).toContain('Gateway');
  });

  it('netstat on server shows Oracle listener port', async () => {
    const out = await server.executeCommand('netstat -tlnp');
    expect(out).toContain(':1521');
  });
});

describe('ss', () => {

  it('ss -tlnp shows listening sockets', async () => {
    const out = await server.executeCommand('ss -tlnp');
    expect(out).toContain(':22');
    expect(out).toContain('LISTEN');
  });

  it('ss -s shows summary', async () => {
    const out = await server.executeCommand('ss -s');
    expect(out).toContain('Total:');
    expect(out).toContain('TCP:');
  });
});

describe('curl', () => {

  it('curl localhost returns HTML', async () => {
    const out = await server.executeCommand('curl localhost');
    expect(out).toContain('<html>');
    expect(out).toContain('It works');
  });

  it('curl external host shows DNS error', async () => {
    const out = await server.executeCommand('curl example.com');
    expect(out).toContain('Could not resolve host');
  });

  it('curl with no args shows usage', async () => {
    const out = await server.executeCommand('curl');
    expect(out).toContain('curl --help');
  });
});

describe('wget', () => {

  it('wget localhost shows download', async () => {
    const out = await server.executeCommand('wget localhost/index.html');
    expect(out).toContain('200 OK');
    expect(out).toContain('saved');
  });

  it('wget external shows DNS failure', async () => {
    const out = await server.executeCommand('wget http://example.com');
    expect(out).toContain('unable to resolve');
  });
});

describe('ping', () => {

  it('ping shows ICMP responses', async () => {
    const out = await server.executeCommand('ping 10.0.0.1');
    expect(out).toContain('PING');
    expect(out).toContain('icmp_seq');
    expect(out).toContain('0% packet loss');
  });

  it('ping with no host shows usage', async () => {
    const out = await server.executeCommand('ping');
    expect(out).toContain('Destination address required');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: apt/dpkg, lscpu, misc
// ═══════════════════════════════════════════════════════════════════

describe('apt / dpkg', () => {

  it('apt update shows package list update', async () => {
    const out = await server.executeCommand('apt update');
    expect(out).toContain('Reading package lists');
  });

  it('apt install shows already installed', async () => {
    const out = await server.executeCommand('apt install vim');
    expect(out).toContain('newest version');
  });

  it('dpkg -l shows installed packages', async () => {
    const out = await server.executeCommand('dpkg -l');
    expect(out).toContain('bash');
    expect(out).toContain('coreutils');
  });
});

describe('lscpu', () => {
  it('lscpu shows CPU information', async () => {
    const out = await server.executeCommand('lscpu');
    expect(out).toContain('Architecture');
    expect(out).toContain('x86_64');
    expect(out).toContain('CPU(s)');
  });
});

describe('seq', () => {
  it('seq 5 generates 1 to 5', async () => {
    const out = await server.executeCommand('seq 5');
    expect(out.trim()).toBe('1\n2\n3\n4\n5');
  });

  it('seq 3 7 generates 3 to 7', async () => {
    const out = await server.executeCommand('seq 3 7');
    expect(out.trim()).toBe('3\n4\n5\n6\n7');
  });
});

describe('basename / dirname', () => {
  it('basename extracts filename', async () => {
    const out = await server.executeCommand('basename /usr/local/bin/sqlplus');
    expect(out.trim()).toBe('sqlplus');
  });

  it('dirname extracts directory', async () => {
    const out = await server.executeCommand('dirname /usr/local/bin/sqlplus');
    expect(out.trim()).toBe('/usr/local/bin');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Oracle Data Pump (expdp / impdp)
// ═══════════════════════════════════════════════════════════════════

describe('Oracle expdp', () => {

  beforeEach(() => {
    initOracleFilesystem(server);
  });

  it('expdp with no args shows usage', async () => {
    // We test via the command handler directly since terminal session dispatch
    // goes through the UI layer; but we can test via LinuxServer executeCommand
    // which goes through LinuxCommandExecutor (expdp won't be there).
    // Instead test the handler function directly.
    const { handleExpdp } = await import('@/terminal/commands/OracleCommands');
    const lines: string[] = [];
    handleExpdp(server, [], (text) => lines.push(text));
    const output = lines.join('\n');
    expect(output).toContain('Usage: expdp');
    expect(output).toContain('SCHEMAS');
    expect(output).toContain('DUMPFILE');
  });

  it('expdp exports HR schema and creates dump file', async () => {
    const { handleExpdp } = await import('@/terminal/commands/OracleCommands');
    const lines: string[] = [];
    handleExpdp(server, ['sys/oracle', 'SCHEMAS=HR', 'DUMPFILE=hr.dmp', 'LOGFILE=hr_exp.log'], (text) => lines.push(text));
    const output = lines.join('\n');
    expect(output).toContain('exported "HR"');
    expect(output).toContain('EMPLOYEES');
    expect(output).toContain('DEPARTMENTS');
    expect(output).toContain('successfully completed');

    // Verify dump file exists on VFS
    const dumpContent = await server.executeCommand('cat /u01/app/oracle/admin/ORCL/dpdump/hr.dmp');
    expect(dumpContent).toContain('ORACLE DATA PUMP DUMP');

    // Verify log file exists
    const logContent = await server.executeCommand('cat /u01/app/oracle/admin/ORCL/dpdump/hr_exp.log');
    expect(logContent).toContain('Export');
    expect(logContent).toContain('HR');
  });

  it('expdp with TABLES exports specific tables', async () => {
    const { handleExpdp } = await import('@/terminal/commands/OracleCommands');
    const lines: string[] = [];
    handleExpdp(server, ['sys/oracle', 'TABLES=HR.EMPLOYEES', 'DUMPFILE=emp.dmp'], (text) => lines.push(text));
    const output = lines.join('\n');
    expect(output).toContain('exported "HR"."EMPLOYEES"');
    expect(output).not.toContain('DEPARTMENTS');
  });
});

describe('Oracle impdp', () => {

  beforeEach(() => {
    initOracleFilesystem(server);
  });

  it('impdp with no args shows usage', async () => {
    const { handleImpdp } = await import('@/terminal/commands/OracleCommands');
    const lines: string[] = [];
    handleImpdp(server, [], (text) => lines.push(text));
    const output = lines.join('\n');
    expect(output).toContain('Usage: impdp');
    expect(output).toContain('REMAP_SCHEMA');
  });

  it('impdp fails when dump file does not exist', async () => {
    const { handleImpdp } = await import('@/terminal/commands/OracleCommands');
    const lines: string[] = [];
    handleImpdp(server, ['sys/oracle', 'DUMPFILE=nonexistent.dmp'], (text) => lines.push(text));
    const output = lines.join('\n');
    expect(output).toContain('ORA-39143');
    expect(output).toContain('not found');
  });

  it('impdp succeeds when dump file exists (after expdp)', async () => {
    const { handleExpdp, handleImpdp } = await import('@/terminal/commands/OracleCommands');

    // First export
    const expLines: string[] = [];
    handleExpdp(server, ['sys/oracle', 'SCHEMAS=HR', 'DUMPFILE=hr.dmp'], (text) => expLines.push(text));

    // Then import
    const impLines: string[] = [];
    handleImpdp(server, ['sys/oracle', 'SCHEMAS=HR', 'DUMPFILE=hr.dmp', 'LOGFILE=hr_imp.log'], (text) => impLines.push(text));
    const output = impLines.join('\n');
    expect(output).toContain('successfully completed');
    expect(output).toContain('imported "HR"');

    // Log file should exist
    const logContent = await server.executeCommand('cat /u01/app/oracle/admin/ORCL/dpdump/hr_imp.log');
    expect(logContent).toContain('Import');
  });

  it('impdp with REMAP_SCHEMA shows remap message', async () => {
    const { handleExpdp, handleImpdp } = await import('@/terminal/commands/OracleCommands');
    const expLines: string[] = [];
    handleExpdp(server, ['sys/oracle', 'SCHEMAS=HR', 'DUMPFILE=remap.dmp'], (text) => expLines.push(text));

    const impLines: string[] = [];
    handleImpdp(server, ['sys/oracle', 'SCHEMAS=HR', 'DUMPFILE=remap.dmp', 'REMAP_SCHEMA=HR:HR_COPY'], (text) => impLines.push(text));
    const output = impLines.join('\n');
    expect(output).toContain('Remapping schema "HR" to "HR_COPY"');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 9: Commands on LinuxPC (non-server)
// ═══════════════════════════════════════════════════════════════════

describe('commands on LinuxPC', () => {

  it('systemctl on PC does not show oracle-ohasd', async () => {
    const out = await pc.executeCommand('systemctl list-units');
    expect(out).not.toContain('oracle-ohasd');
  });

  it('netstat on PC does not show Oracle port', async () => {
    const out = await pc.executeCommand('netstat -tlnp');
    expect(out).not.toContain(':1521');
  });

  it('df works on PC', async () => {
    const out = await pc.executeCommand('df -h');
    expect(out).toContain('Size');
    expect(out).toContain('/dev/sda1');
  });

  it('free works on PC', async () => {
    const out = await pc.executeCommand('free -h');
    expect(out).toContain('Mem:');
  });
});
