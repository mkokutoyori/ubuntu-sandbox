/**
 * TDD Tests for Linux Logging System
 *
 * Group 1: logger command (write log entries)
 * Group 2: journalctl basic viewing
 * Group 3: journalctl filtering (unit, priority, time)
 * Group 4: journalctl output formats
 * Group 5: dmesg (kernel ring buffer)
 * Group 6: Log files (/var/log/)
 * Group 7: Journal management commands
 * Group 8: Permissions and error handling
 * Group 9: Advanced scenarios and combinations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: logger command
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: logger command', () => {
  it('should log a basic message', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('logger "Hello World"');
    expect(result).toBe('');

    const journal = await server.executeCommand('journalctl -n 1 -o cat');
    expect(journal).toContain('Hello World');
  });

  it('should log with a custom tag using -t', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -t myapp "Application started"');

    const journal = await server.executeCommand('journalctl -n 1');
    expect(journal).toContain('myapp');
    expect(journal).toContain('Application started');
  });

  it('should log with priority using -p', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p user.err "Disk failure"');

    const journal = await server.executeCommand('journalctl -p err -o cat -n 1');
    expect(journal).toContain('Disk failure');
  });

  it('should log with facility.priority and route to correct log file', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p auth.warning "Suspicious login attempt"');

    const authLog = await server.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain('Suspicious login attempt');
  });

  it('should include PID when using -i flag', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -i "Process message"');

    const journal = await server.executeCommand('journalctl -n 1');
    expect(journal).toMatch(/\[\d+\]/);
    expect(journal).toContain('Process message');
  });

  it('should join multiple arguments as the message', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger hello world test');

    const journal = await server.executeCommand('journalctl -n 1 -o cat');
    expect(journal).toContain('hello world test');
  });

  it('should write to /var/log/syslog by default', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Syslog test entry"');

    const syslog = await server.executeCommand('cat /var/log/syslog');
    expect(syslog).toContain('Syslog test entry');
  });

  it('should use default user.notice priority when -p not specified', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Default priority"');

    // user.notice = priority 5 (notice), should appear with -p notice
    const journal = await server.executeCommand('journalctl -p notice -o cat -n 1');
    expect(journal).toContain('Default priority');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: journalctl basic viewing
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: journalctl basic viewing', () => {
  it('should show all log entries with header', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl');
    expect(result).toContain('-- Logs begin at');
    expect(result).toContain('kernel');
  });

  it('should show last N entries with -n', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Entry 1"');
    await server.executeCommand('logger "Entry 2"');
    await server.executeCommand('logger "Entry 3"');

    const result = await server.executeCommand('journalctl -n 2 -o cat');
    expect(result).toContain('Entry 2');
    expect(result).toContain('Entry 3');
    expect(result).not.toContain('Entry 1');
  });

  it('should show all entries when no -n specified', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl');
    // Should contain boot messages + header
    expect(result).toContain('-- Logs begin at');
    expect(result).toContain('systemd');
  });

  it('should show entries in reverse with -r', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -t app "First"');
    await server.executeCommand('logger -t app "Second"');

    const result = await server.executeCommand('journalctl -r -n 2 -o cat');
    const lines = result.trim().split('\n');
    expect(lines[0]).toContain('Second');
    expect(lines[1]).toContain('First');
  });

  it('should show current boot with -b', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -b');
    expect(result).toContain('kernel');
    expect(result).toContain('systemd');
  });

  it('should work with --no-pager flag', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --no-pager');
    expect(result).toContain('-- Logs begin at');
  });

  it('should suppress header/footer with -q', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -q');
    expect(result).not.toContain('-- Logs begin at');
    expect(result).toContain('kernel');
  });

  it('should show entries with syslog-style timestamps', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -n 1');
    // Should match pattern: "Mon DD HH:MM:SS hostname tag: message"
    expect(result).toMatch(/\w{3}\s+\d+\s+\d+:\d+:\d+/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: journalctl filtering
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: journalctl filtering', () => {
  it('should filter by unit with -u ssh', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -u ssh');
    expect(result).toContain('sshd');
  });

  it('should filter by unit with -u systemd', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -u systemd');
    expect(result).toContain('systemd');
  });

  it('should return "No entries" for non-existent unit', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -u nonexistent');
    expect(result).toBe('-- No entries --');
  });

  it('should filter by priority name with -p err', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p user.err "Error message"');
    await server.executeCommand('logger -p user.info "Info message"');

    const result = await server.executeCommand('journalctl -p err -o cat');
    expect(result).toContain('Error message');
    expect(result).not.toContain('Info message');
  });

  it('should filter by numeric priority with -p 3', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p user.err "Error here"');
    await server.executeCommand('logger -p user.debug "Debug here"');

    const result = await server.executeCommand('journalctl -p 3 -o cat');
    expect(result).toContain('Error here');
    expect(result).not.toContain('Debug here');
  });

  it('should include higher severity when filtering by priority', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p user.crit "Critical!"');
    await server.executeCommand('logger -p user.err "Error!"');
    await server.executeCommand('logger -p user.warning "Warning!"');
    await server.executeCommand('logger -p user.info "Info!"');

    // -p warning shows emerg(0) through warning(4)
    const result = await server.executeCommand('journalctl -p warning -o cat');
    expect(result).toContain('Critical!');
    expect(result).toContain('Error!');
    expect(result).toContain('Warning!');
    expect(result).not.toContain('Info!');
  });

  it('should combine unit and priority filters', async () => {
    const server = new LinuxServer('srv', 'S1');
    // Pre-populated ssh entries are info-level, so -p err with -u ssh yields nothing
    const result = await server.executeCommand('journalctl -u ssh -p err');
    expect(result).toBe('-- No entries --');
  });

  it('should filter by PID with _PID=', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl _PID=1');
    expect(result).toContain('systemd');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: journalctl output formats
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: journalctl output formats', () => {
  it('should output short format by default', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -n 1');
    // Short format: "Mon DD HH:MM:SS hostname tag[pid]: message"
    expect(result).toMatch(/\w{3}\s+\d+\s+\d+:\d+:\d+\s+\S+\s+\S+/);
  });

  it('should output short-iso format', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -o short-iso -n 1');
    // ISO format: "2024-01-15T08:00:01+0000 hostname tag[pid]: message"
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should output JSON format', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -t test "JSON test"');
    const result = await server.executeCommand('journalctl -n 1 -o json');
    expect(result).toContain('"MESSAGE"');
    expect(result).toContain('"PRIORITY"');
    expect(result).toContain('JSON test');
  });

  it('should output JSON-pretty format', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Pretty test"');
    const result = await server.executeCommand('journalctl -n 1 -o json-pretty');
    expect(result).toContain('"MESSAGE"');
    // Pretty format is indented multi-line
    expect(result.split('\n').length).toBeGreaterThan(1);
  });

  it('should output cat format (message only)', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Cat format test"');
    const result = await server.executeCommand('journalctl -n 1 -o cat');
    expect(result.trim()).toBe('Cat format test');
  });

  it('should output verbose format', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Verbose test"');
    const result = await server.executeCommand('journalctl -n 1 -o verbose');
    expect(result).toContain('MESSAGE=');
    expect(result).toContain('PRIORITY=');
    expect(result).toContain('SYSLOG_IDENTIFIER=');
  });

  it('should show only specified fields with --output-fields', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "Fields test"');
    const result = await server.executeCommand('journalctl -n 1 -o json --output-fields=MESSAGE,PRIORITY');
    expect(result).toContain('MESSAGE');
    expect(result).toContain('PRIORITY');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: dmesg (kernel ring buffer)
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: dmesg (kernel ring buffer)', () => {
  it('should display kernel boot messages', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('dmesg');
    expect(result).toContain('Linux version');
  });

  it('should show timestamps in bracket format', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('dmesg');
    // Default format: [    0.000000] message
    expect(result).toMatch(/\[\s*\d+\.\d+\]/);
  });

  it('should show human-readable timestamps with -T', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('dmesg -T');
    // Human format: [Mon Jan 15 08:00:00 2024] message
    expect(result).toMatch(/\[\w{3} \w{3}\s+\d+/);
  });

  it('should filter by level with -l err', async () => {
    const server = new LinuxServer('srv', 'S1');
    const all = await server.executeCommand('dmesg');
    const errors = await server.executeCommand('dmesg -l err');
    // Errors should be a subset of all messages
    const errorLineCount = errors.trim() ? errors.trim().split('\n').length : 0;
    const allLineCount = all.trim().split('\n').length;
    expect(errorLineCount).toBeLessThanOrEqual(allLineCount);
  });

  it('should filter by multiple levels with -l warn,err', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('dmesg -l warn,err');
    // Valid filter, might be empty if no warn/err messages at boot
    expect(typeof result).toBe('string');
  });

  it('should clear the buffer with -c', async () => {
    const server = new LinuxServer('srv', 'S1');
    const before = await server.executeCommand('dmesg');
    expect(before).toContain('Linux version');

    // -c should display then clear
    const cleared = await server.executeCommand('dmesg -c');
    expect(cleared).toContain('Linux version');

    // After -c, dmesg should be empty
    const after = await server.executeCommand('dmesg');
    expect(after).toBe('');
  });

  it('should contain network-related boot messages', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('dmesg');
    expect(result).toContain('NET:');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Log files (/var/log/)
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Log files (/var/log/)', () => {
  it('should have /var/log/syslog on boot', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('cat /var/log/syslog');
    expect(result).not.toContain('No such file');
    expect(result).toContain('systemd');
  });

  it('should have /var/log/auth.log on boot', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('cat /var/log/auth.log');
    expect(result).not.toContain('No such file');
  });

  it('should have /var/log/kern.log on boot', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('cat /var/log/kern.log');
    expect(result).not.toContain('No such file');
    expect(result).toContain('kernel');
  });

  it('should have /var/log/boot.log on boot', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('cat /var/log/boot.log');
    expect(result).not.toContain('No such file');
  });

  it('should append logger entries to /var/log/syslog', async () => {
    const server = new LinuxServer('srv', 'S1');
    const before = await server.executeCommand('cat /var/log/syslog');
    await server.executeCommand('logger "New syslog entry"');
    const after = await server.executeCommand('cat /var/log/syslog');

    expect(after).toContain('New syslog entry');
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('should route kern messages to /var/log/kern.log', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p kern.warning "Kernel test warning"');

    const kernLog = await server.executeCommand('cat /var/log/kern.log');
    expect(kernLog).toContain('Kernel test warning');
  });

  it('should route auth messages to /var/log/auth.log', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p auth.info "Auth test info"');

    const authLog = await server.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain('Auth test info');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: Journal management commands
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Journal management commands', () => {
  it('should report disk usage with --disk-usage', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --disk-usage');
    expect(result).toContain('Archived and active journals take up');
    expect(result).toMatch(/\d+(\.\d+)?\s*[KMG]/);
  });

  it('should list boots with --list-boots', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --list-boots');
    expect(result).toContain('0');
  });

  it('should rotate journal with --rotate', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --rotate');
    expect(result).toContain('Rotating');
  });

  it('should flush journal with --flush', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --flush');
    expect(result).toContain('Flushing');
  });

  it('should vacuum by time with --vacuum-time', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --vacuum-time=1d');
    expect(result).toContain('Vacuuming done');
  });

  it('should vacuum by size with --vacuum-size', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --vacuum-size=10M');
    expect(result).toContain('Vacuuming done');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Permissions and error handling
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Permissions and error handling', () => {
  it('should allow non-root to use logger', async () => {
    const pc = new LinuxPC('pc', 'PC1');
    const result = await pc.executeCommand('logger "User log entry"');
    expect(result).toBe('');

    const journal = await pc.executeCommand('journalctl -n 1 -o cat');
    expect(journal).toContain('User log entry');
  });

  it('should allow non-root to view journal', async () => {
    const pc = new LinuxPC('pc', 'PC1');
    const result = await pc.executeCommand('journalctl -n 5');
    expect(result).toContain('localhost');
  });

  it('should allow non-root to use dmesg', async () => {
    const pc = new LinuxPC('pc', 'PC1');
    const result = await pc.executeCommand('dmesg');
    expect(result).toContain('Linux version');
  });

  it('should reject invalid priority for journalctl -p', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -p invalid');
    expect(result).toContain('Invalid');
  });

  it('should reject invalid output format for journalctl -o', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -o badformat');
    expect(result).toContain('Invalid');
  });

  it('should reject dmesg -c for non-root', async () => {
    const pc = new LinuxPC('pc', 'PC1');
    const result = await pc.executeCommand('dmesg -c');
    expect(result).toContain('Permission denied');
  });

  it('should show error for logger with invalid priority', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('logger -p invalid.badlevel "test"');
    expect(result).toContain('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 9: Advanced scenarios and combinations
// ═══════════════════════════════════════════════════════════════════

describe('Group 9: Advanced scenarios and combinations', () => {
  it('should track multiple sequential logger calls in order', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "First"');
    await server.executeCommand('logger "Second"');
    await server.executeCommand('logger "Third"');

    const result = await server.executeCommand('journalctl -n 3 -o cat');
    const lines = result.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('First');
    expect(lines[1]).toBe('Second');
    expect(lines[2]).toBe('Third');
  });

  it('should support journalctl piped to grep', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -t myapp "Error: connection failed"');
    await server.executeCommand('logger -t myapp "Info: all good"');

    const result = await server.executeCommand('journalctl -o cat | grep Error');
    expect(result).toContain('Error: connection failed');
    expect(result).not.toContain('all good');
  });

  it('should support journalctl piped to wc -l', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl -o cat | wc -l');
    const count = parseInt(result.trim());
    expect(count).toBeGreaterThan(0);
  });

  it('should route different facilities to correct log files', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger -p auth.info "Auth event"');
    await server.executeCommand('logger -p kern.info "Kernel event"');
    await server.executeCommand('logger -p user.info "User event"');

    const authLog = await server.executeCommand('cat /var/log/auth.log');
    const kernLog = await server.executeCommand('cat /var/log/kern.log');
    const syslog = await server.executeCommand('cat /var/log/syslog');

    expect(authLog).toContain('Auth event');
    expect(kernLog).toContain('Kernel event');
    expect(syslog).toContain('User event');
  });

  it('should not show user logger entries in dmesg', async () => {
    const server = new LinuxServer('srv', 'S1');
    await server.executeCommand('logger "User space message"');

    const dmesg = await server.executeCommand('dmesg');
    expect(dmesg).not.toContain('User space message');
  });

  it('should contain systemd messages in boot.log', async () => {
    const server = new LinuxServer('srv', 'S1');
    const bootLog = await server.executeCommand('cat /var/log/boot.log');
    expect(bootLog).toContain('systemd');
  });

  it('should show version info with journalctl --version', async () => {
    const server = new LinuxServer('srv', 'S1');
    const result = await server.executeCommand('journalctl --version');
    expect(result).toContain('systemd');
  });
});
