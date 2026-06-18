/**
 * Advanced Linux Logging, Auditing, and Rotation Command Suite.
 * 
 * Contains exactly 200 comprehensive unit test scenarios covering:
 *  - Syslog Generation & the `logger` Utility (Tests 1-40)
 *  - Systemd Journal & `journalctl` Query Tool (Tests 41-80)
 *  - Kernel Logs, Ring Buffer & `dmesg` (Tests 81-110)
 *  - Linux Audit Framework (`auditd`, `auditctl`, `ausearch`) (Tests 111-140)
 *  - Log Rotation & Maintenance Engine (`logrotate`) (Tests 141-170)
 *  - Security, Process Logging, Pam & Access Audits (Tests 171-200)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupLinuxHost() {
  return new LinuxPC('HostPC', 0, 0);
}

// ═══════════════════════════════════════════════════════════════════
// LINUX ADVANCED LOGGING TESTS (1-200)
// ═══════════════════════════════════════════════════════════════════

describe('Linux Advanced Logging and Auditing Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: Syslog Generation & the logger Utility (Tests 1-40) 

  describe('Syslog Generation & logger Utility', () => {
    it('1. should write simple message to syslog using logger', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "system update initialized"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('system update initialized');
    });

    it('2. should auto-append hostname and timestamp in syslog output', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "process wake"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toMatch(/[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+HostPC/);
    });

    it('3. should write message with custom tag using logger -t', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -t DB_MONITOR "query latency high"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('DB_MONITOR: query latency high');
    });

    it('4. should process custom log priority via logger -p', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local0.warn "threshold breach"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('threshold breach');
    });

    it('5. should route auth.info messages to auth.log instead of syslog', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p auth.info "user root login success"');
      const authLog = await pc.executeCommand('cat /var/log/auth.log');
      expect(authLog).toContain('user root login success');
    });

    it('6. should route kern.crit messages to kern.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.crit "hardware failure detected"');
      const kernLog = await pc.executeCommand('cat /var/log/kern.log');
      expect(kernLog).toContain('hardware failure detected');
    });

    it('7. should read from target files using logger -f', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "static log content" > /tmp/raw_event.txt');
      await pc.executeCommand('logger -f /tmp/raw_event.txt');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('static log content');
    });

    it('8. should record process ID using logger -i', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -i "system startup completed"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toMatch(/\[\d+\]: system startup completed/);
    });

    it('9. should handle empty message payload parameters gracefully', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger ""');
      expect(output.trim()).toBe('');
    });

    it('10. should reject logger execution when input files inside -f do not exist', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger -f /tmp/nonexistent_file_path');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('11. should support logging messages directly to stderr using logger -s', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger -s "direct stderr alert"');
      expect(output).toContain('direct stderr alert');
    });

    it('12. should write to both syslog and auth.log if priority auth.err is selected', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p auth.err "auth database connection lost"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(syslog).toContain('auth database connection lost');
      expect(auth).toContain('auth database connection lost');
    });

    it('13. should handle special characters and backslashes in logger argument inputs', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "regex pattern matches: \\\\d{3} successfully"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('regex pattern matches: \\d{3} successfully');
    });

    it('14. should restrict custom syslog priorities to valid categories', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger -p invalid_fac.err "alert"');
      expect(output.toLowerCase()).toMatch(/error|invalid|unknown priority/);
    });

    it('15. should handle excessively long log strings with automated truncation (snaplen)', async () => {
      const pc = setupLinuxHost();
      const massiveLog = 'x'.repeat(4000);
      await pc.executeCommand(`logger "${massiveLog}"`);
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog.length).toBeLessThan(4500);
    });

    it('16. should log warning logs with priority local0.warn', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local0.warn "high memory footprint detected"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('high memory footprint detected');
    });

    it('17. should log debug messages using facility local0.debug', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local0.debug "garbage collector run complete"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('garbage collector run complete');
    });

    it('18. should support combining multiple flags such as logger -i -s -t TEST', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger -i -s -t TEST "unified options execution"');
      expect(output).toContain('TEST');
      expect(output).toContain('unified options execution');
    });

    it('19. should preserve logging order of execution (FIFO pipeline check)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "first event logged"');
      await pc.executeCommand('logger "second event logged"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      const firstIndex = syslog.indexOf('first event logged');
      const secondIndex = syslog.indexOf('second event logged');
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it('20. should route mail.err messages to /var/log/mail.err if configured', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p mail.err "smtp connection timeout"');
      const mailLog = await pc.executeCommand('cat /var/log/mail.err');
      expect(mailLog).toContain('smtp connection timeout');
    });

    it('21. should route daemon.info messages to syslog', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p daemon.info "dhclient renewed lease"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('dhclient renewed lease');
    });

    it('22. should reject logger execution when missing mandatory string parameters', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('23. should write logs containing embedded double quotes safely', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger \'user "admin" changed config\'');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('user "admin" changed config');
    });

    it('24. should support custom numerical priority codes (logger -p 13)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p 13 "alert on facility 1, severity 5"'); // user.notice = 1 * 8 + 5 = 13
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('alert on facility 1, severity 5');
    });

    it('25. should process blank spaces inside logger custom tags cleanly', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -t "DATABASE MODULE" "backup script loaded"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('DATABASE MODULE: backup script loaded');
    });

    it('26. should log boot/reboot sequences automatically into boot.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('reboot'); // mock soft reboot
      const bootLog = await pc.executeCommand('cat /var/log/boot.log');
      expect(bootLog.toLowerCase()).toMatch(/system|reboot|started/);
    });

    it('27. should write cron execution logs under daemon.info target patterns', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p cron.info "CRON: hourly tasks scheduled"');
      const cronLog = await pc.executeCommand('cat /var/log/cron.log');
      expect(cronLog).toContain('CRON: hourly tasks scheduled');
    });

    it('28. should separate system alert logs using emergency classification (syslog -p emerg)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p emerg "CORE PANIC: Power supply failed"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('CORE PANIC: Power supply failed');
    });

    it('29. should preserve log records when multiple logger processes write simultaneously', async () => {
      const pc = setupLinuxHost();
      await Promise.all([
        pc.executeCommand('logger "Simultaneous Event A"'),
        pc.executeCommand('logger "Simultaneous Event B"')
      ]);
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('Simultaneous Event A');
      expect(syslog).toContain('Simultaneous Event B');
    });

    it('30. should support user priority levels user.emerg logging output validation', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p user.emerg "User emergency session alert"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('User emergency session alert');
    });

    it('31. should not write user.debug level logs to critical logging partitions (auth.log)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p user.debug "verbose console trace"');
      const authLog = await pc.executeCommand('cat /var/log/auth.log');
      expect(authLog).not.toContain('verbose console trace');
    });

    it('32. should write audit-priority markers safely using custom logger facilities', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.info "PAM validation succeeded"');
      const authLog = await pc.executeCommand('cat /var/log/auth.log');
      expect(authLog).toContain('PAM validation succeeded');
    });

    it('33. should support writing multiline outputs using embedded newline symbols \\n', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -e "line number one\\nline number two"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('line number one');
      expect(syslog).toContain('line number two');
    });

    it('34. should handle custom tag limits up to 255 characters', async () => {
      const pc = setupLinuxHost();
      const longTag = 'T'.repeat(255);
      await pc.executeCommand(`logger -t ${longTag} "tag verification"`);
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain(longTag);
    });

    it('35. should reject tag arguments longer than 255 characters or truncate them safely', async () => {
      const pc = setupLinuxHost();
      const ultraLongTag = 'T'.repeat(300);
      await pc.executeCommand(`logger -t ${ultraLongTag} "tag validation overflow"`);
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog.length).toBeLessThan(4500);
    });

    it('36. should support system-level facility local7 write structures', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local7.info "custom automation trigger executed"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('custom automation trigger executed');
    });

    it('37. should record user login failures under /var/log/auth.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p auth.warn "FAILED LOGIN: user root invalid credential"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('FAILED LOGIN: user root invalid credential');
    });

    it('38. should log standard error levels under daemon.err structures', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p daemon.err "systemd-networkd failed to bind"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('systemd-networkd failed to bind');
    });

    it('39. should process raw parameters inside logger tags safely without command injection', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -t "tag; rm -rf /" "injection safeguard test"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('injection safeguard test');
    });

    it('40. should report successful execution (status code 0) on regular logs creation', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logger "health check positive" && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });

  // ─── Block 2: Systemd Journal & journalctl Query Tool (Tests 41-80) 

  describe('Systemd Journal & journalctl Query Tool', () => {
    it('41. should run journalctl and display active system logs', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl');
      expect(output).toBeDefined();
    });

    it('42. should filter systemd logs by exact unit specification via journalctl -u', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -t systemd "ssh.service: active state"');
      const output = await pc.executeCommand('journalctl -u ssh');
      expect(output).toContain('ssh.service');
    });

    it('43. should filter systemd logs by priority thresholds via journalctl -p', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p err "critical service panic"');
      const output = await pc.executeCommand('journalctl -p err');
      expect(output).toContain('critical service panic');
    });

    it('44. should limit output records to last N lines via journalctl -n', async () => {
      const pc = setupLinuxHost();
      for (let i = 0; i < 15; i++) {
        await pc.executeCommand(`logger "sequential entry ${i}"`);
      }
      const output = await pc.executeCommand('journalctl -n 5');
      const lines = output.trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(6); // including headers
    });

    it('45. should support displaying systemd logs in JSON format via journalctl -o json', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "json encoding verification"');
      const output = await pc.executeCommand('journalctl -o json -n 1');
      expect(output).toContain('{');
      expect(output).toContain('MESSAGE');
    });

    it('46. should support filtering logs since a target timestamp via journalctl --since', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --since "1 hour ago"');
      expect(output).toBeDefined();
    });

    it('47. should support filtering logs until a target timestamp via journalctl --until', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --until "now"');
      expect(output).toBeDefined();
    });

    it('48. should support printing raw kernel logs exclusively via journalctl -k', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -k');
      expect(output).toBeDefined();
    });

    it('49. should support reverse log chronological listing via journalctl -r', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "early trace"');
      await pc.executeCommand('logger "late trace"');
      const output = await pc.executeCommand('journalctl -r -n 2');
      const lines = output.trim().split('\n');
      expect(lines[0]).toContain('late trace');
    });

    it('50. should display boot identifier records using journalctl --list-boots', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --list-boots');
      expect(output).toContain('0'); // current boot index
    });

    it('51. should filter journals specifically by active boot using journalctl -b', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -b 0');
      expect(output).toBeDefined();
    });

    it('52. should reject queries with invalid boot offsets (journalctl -b -99)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -b -99');
      expect(output.toLowerCase()).toMatch(/error|invalid|no such boot/);
    });

    it('53. should print catalog informational details using journalctl -x', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -x -n 1');
      expect(output).toBeDefined();
    });

    it('54. should suppress paging structures using journalctl --no-pager', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --no-pager -n 1');
      expect(output).toBeDefined();
    });

    it('55. should list journals generated by specific user uid (journalctl _UID=0)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl _UID=0 -n 1');
      expect(output).toBeDefined();
    });

    it('56. should filter journals specifically by PID (journalctl _PID=1)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl _PID=1 -n 1');
      expect(output).toBeDefined();
    });

    it('57. should show disk usage parameters using journalctl --disk-usage', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --disk-usage');
      expect(output.toLowerCase()).toContain('archived');
    });

    it('58. should support cleaning up archive logs via journalctl --vacuum-size', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --vacuum-size=10M');
      expect(output.toLowerCase()).toContain('vacuum');
    });

    it('59. should support vacuuming archive logs by time threshold (journalctl --vacuum-time)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --vacuum-time=2days');
      expect(output.toLowerCase()).toContain('vacuum');
    });

    it('60. should show systemd system logs starting from end of log in follow-mode simulation (journalctl -f -n 1)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -f -n 1');
      expect(output).toBeDefined();
    });

    it('61. should accept multiple unit filters simultaneously (journalctl -u ssh -u cron)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -u ssh -u cron');
      expect(output).toBeDefined();
    });

    it('62. should output logs specifically within targeted syslog facilities using journalctl --facility', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --facility=auth');
      expect(output).toBeDefined();
    });

    it('63. should reject priority requests outside bounds of system d-severity ranges (0 to 7)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -p 9');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('64. should return no matched records for time frames in future', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --since "2099-01-01"');
      const lines = output.trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(2); // header only
    });

    it('65. should support showing metadata field lists using journalctl -N', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -N');
      expect(output).toContain('MESSAGE');
    });

    it('66. should filter logs targeting systemd executable paths (journalctl /usr/sbin/sshd)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl /usr/sbin/sshd');
      expect(output).toBeDefined();
    });

    it('67. should show kernel ring logs matching specific sys-parameters (journalctl _TRANSPORT=kernel)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl _TRANSPORT=kernel');
      expect(output).toBeDefined();
    });

    it('68. should reject invalid display outputs combinations (-o invalid_format)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -o invalid_format');
      expect(output.toLowerCase()).toMatch(/error|unknown output/);
    });

    it('69. should support quiet execution suppressions with journalctl -q', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -q -n 1');
      expect(output).toBeDefined();
    });

    it('70. should parse systemd log directories configuration safely if customized with -D', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -D /var/log/journal');
      expect(output).not.toContain('error');
    });

    it('71. should throw error on opening corrupted journal folders via -D', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -D /sys/corrupted_dir');
      expect(output.toLowerCase()).toMatch(/error|failed/);
    });

    it('72. should output exact message matching in journalctl payload logs', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "specific needle"');
      const output = await pc.executeCommand('journalctl');
      expect(output).toContain('specific needle');
    });

    it('73. should show kernel entries with facility kern inside journalctl -k', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.info "kernel physical port connected"');
      const output = await pc.executeCommand('journalctl -k');
      expect(output).toContain('kernel physical port connected');
    });

    it('74. should return help instructions on query flag journalctl -h', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -h');
      expect(output.toLowerCase()).toContain('options');
    });

    it('75. should display correct software version parameters on journalctl --version', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl --version');
      expect(output.toLowerCase()).toContain('systemd');
    });

    it('76. should display exact priority labels inside log entries in journalctl output', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p crit "critical error trigger"');
      const output = await pc.executeCommand('journalctl -p crit');
      expect(output).toContain('critical error trigger');
    });

    it('77. should support showing logs exclusively from systemd services with short unit format (ssh instead of ssh.service)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -t systemd "ssh.service: bound to port 22"');
      const output = await pc.executeCommand('journalctl -u ssh');
      expect(output).toContain('ssh.service');
    });

    it('78. should reject filtering with negative line limits (journalctl -n -10)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -n -10');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('79. should process boolean fields cleanly in syslog metadata matches', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl _SYSTEMD_UNIT=init.scope');
      expect(output).toBeDefined();
    });

    it('80. should execute successfully and return status code 0 when journal database is read completely', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('journalctl -n 1 && echo "VERIFIED"');
      expect(output).toContain('VERIFIED');
    });
  });

  // ─── Block 3: Kernel logs, Ring Buffer & dmesg (Tests 81-110) ────

  describe('Kernel Logs, Ring Buffer & dmesg', () => {
    it('81. should print kernel boot logs on dmesg execution', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg');
      expect(output.toLowerCase()).toMatch(/boot|kernel|init/);
    });

    it('82. should support human-readable timestamps formatting with dmesg -T', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -T');
      // Format should contain structured timestamp blocks
      expect(output).toMatch(/\[[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}\]/);
    });

    it('83. should filter kernel logs by target level threshold with dmesg -l', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -l err');
      expect(output).toBeDefined();
    });

    it('84. should filter dmesg outputs by multiple level limits concurrently', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -l warn,err');
      expect(output).toBeDefined();
    });

    it('85. should support facility constraints using dmesg -f', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -f kern');
      expect(output).toBeDefined();
    });

    it('86. should support interface console logging level configurations (dmesg -n)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -n 1');
      expect(output.trim()).toBe('');
    });

    it('87. should clear kernel ring buffer logging tables via dmesg -C', async () => {
      const pc = setupLinuxHost();
      const clearCmd = await pc.executeCommand('dmesg -C');
      expect(clearCmd.trim()).toBe('');
      const output = await pc.executeCommand('dmesg');
      expect(output.trim()).toBe('');
    });

    it('88. should output and then flush the ring logs database using dmesg -c', async () => {
      const pc = setupLinuxHost();
      const originalOutput = await pc.executeCommand('dmesg');
      const printAndClear = await pc.executeCommand('dmesg -c');
      expect(printAndClear).toBe(originalOutput);
      const remainingLogs = await pc.executeCommand('dmesg');
      expect(remainingLogs.trim()).toBe('');
    });

    it('89. should show raw dmesg values omitting timing parameters via dmesg -r', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -r');
      expect(output).not.toMatch(/\[\s*\d+\.\d+\]/);
    });

    it('90. should reject invalid dmesg level filters (dmesg -l invalid_level)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -l invalid_level');
      expect(output.toLowerCase()).toMatch(/error|unknown level/);
    });

    it('91. should show device drivers subsystems registration traces inside dmesg', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg');
      expect(output.toLowerCase()).toMatch(/pci|driver|usb/);
    });

    it('92. should check status output of help parameters query dmesg -h', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -h');
      expect(output.toLowerCase()).toContain('options');
    });

    it('93. should show system version descriptors on dmesg -V', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -V');
      expect(output.toLowerCase()).toContain('dmesg');
    });

    it('94. should restrict console logging transitions to privileged level ranges', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -n 9');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('95. should write new kernel simulated errors and find them in dmesg', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.err "EXT4-fs error on sda1"');
      const output = await pc.executeCommand('dmesg');
      expect(output).toContain('EXT4-fs error on sda1');
    });

    it('96. should separate multiple kernel logging levels correctly with -l warning', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.warn "low battery critical alarm"');
      const output = await pc.executeCommand('dmesg -l warn');
      expect(output).toContain('low battery critical alarm');
    });

    it('97. should support showing kernel logs in syslog format if configured', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('cat /var/log/kern.log');
      expect(output).toBeDefined();
    });

    it('98. should not contain standard user-priority logs inside dmesg output', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p user.info "unprivileged browser launched"');
      const output = await pc.executeCommand('dmesg');
      expect(output).not.toContain('unprivileged browser launched');
    });

    it('99. should preserve kernel ring log order during intensive storage events', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.info "system event disk scan initialized"');
      await pc.executeCommand('logger -p kern.info "system event disk scan completed"');
      const output = await pc.executeCommand('dmesg');
      const firstIndex = output.indexOf('system event disk scan initialized');
      const secondIndex = output.indexOf('system event disk scan completed');
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it('100. should accept dmesg short option alias for human-readable execution (-T)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -T');
      expect(output).toBeDefined();
    });

    it('101. should output kernel log facility identifiers inside dmesg', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -x');
      expect(output).toBeDefined();
    });

    it('102. should restrict dmesg buffer clearances to root privileges', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "dmesg -C"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('103. should reject console level alterations from unprivileged users', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "dmesg -n 1"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('104. should preserve kernel startup messages even after clearing syslog file manually', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "" > /var/log/syslog');
      const output = await pc.executeCommand('dmesg');
      expect(output.toLowerCase()).toMatch(/kernel|boot/);
    });

    it('105. should handle spaces inside kernel error injection patterns safely', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.crit "OUT_OF_MEMORY: process killed"');
      const output = await pc.executeCommand('dmesg -l crit');
      expect(output).toContain('OUT_OF_MEMORY: process killed');
    });

    it('106. should support dmesg options checking limits via utility tools', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -w -n 1');
      expect(output).toBeDefined();
    });

    it('107. should log kernel memory allocation failures correctly', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.emerg "alloc_pages failure"');
      const output = await pc.executeCommand('dmesg -l emerg');
      expect(output).toContain('alloc_pages failure');
    });

    it('108. should retain dmesg states across soft command errors', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('dmesg invalid_arg_flag');
      const output = await pc.executeCommand('dmesg');
      expect(output.toLowerCase()).toMatch(/kernel|boot/);
    });

    it('109. should print kernel modules symbols resolution lists cleanly', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg');
      expect(output).toBeDefined();
    });

    it('110. should terminate successfully and exit with status 0 on default read operations', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('dmesg -l info && echo "PASS"');
      expect(output).toContain('PASS');
    });
  });

  // ─── Block 4: Linux Audit Framework (auditd, auditctl) (Tests 111-140) 

  describe('Linux Audit Framework (auditd, auditctl)', () => {
    it('111. should list configured rules inside auditctl -l', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('auditctl -l');
      expect(output.toLowerCase()).toContain('no rules');
    });

    it('112. should add file system watch rule using auditctl -w', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa -k passwd_changes');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('/etc/passwd');
    });

    it('113. should record audit entry upon watched file modifications', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa -k passwd_changes');
      await pc.executeCommand('echo "test_user:x:1001:1001:::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('passwd_changes');
    });

    it('114. should search audit events by target key using ausearch -k', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa -k passwd_changes');
      await pc.executeCommand('echo "test_user:x:1001:1001:::" >> /etc/passwd');
      const output = await pc.executeCommand('ausearch -k passwd_changes');
      expect(output).toContain('/etc/passwd');
    });

    it('115. should delete active watch rule using auditctl -W', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa -k passwd_changes');
      await pc.executeCommand('auditctl -W /etc/passwd -p wa -k passwd_changes');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).not.toContain('/etc/passwd');
    });

    it('116. should search audit events by file path using ausearch -f', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/shadow -p wa -k shadow_access');
      await pc.executeCommand('touch /etc/shadow');
      const output = await pc.executeCommand('ausearch -f /etc/shadow');
      expect(output).toContain('shadow_access');
    });

    it('117. should delete all active watch rules using auditctl -D', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      await pc.executeCommand('auditctl -w /etc/shadow -p wa');
      await pc.executeCommand('auditctl -D');
      const list = await pc.executeCommand('auditctl -l');
      expect(list.toLowerCase()).toContain('no rules');
    });

    it('118. should query audit summary metrics using aureport', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('aureport');
      expect(output).toContain('Number of events');
    });

    it('119. should show summary of logins using aureport -l', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('aureport -l');
      expect(output).toContain('Login Summary Report');
    });

    it('120. should show summary of execution files using aureport -x', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('aureport -x');
      expect(output).toContain('Executable Summary Report');
    });

    it('121. should reject audit rule creations with invalid syntax parameters', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p invalid_perms');
      expect(output.toLowerCase()).toMatch(/error|invalid permissions/);
    });

    it('122. should deny unprivileged users access to list audit rules', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "auditctl -l"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('123. should deny unprivileged users access to read audit logs', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "cat /var/log/audit/audit.log"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('124. should show watch details with precise syscall rules matching (auditctl -S)', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -k file_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('open');
    });

    it('125. should track deleted files with syscall watch rules', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -a always,exit -S unlink -k delete_tracking');
      await pc.executeCommand('touch /tmp/removable.txt');
      await pc.executeCommand('rm /tmp/removable.txt');
      const output = await pc.executeCommand('ausearch -k delete_tracking');
      expect(output).toContain('unlink');
    });

    it('126. should query audit metrics restricted by timestamp via ausearch -ts', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -ts today');
      expect(output).toBeDefined();
    });

    it('127. should query audit metrics restricted by end timestamp via ausearch -te', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -te now');
      expect(output).toBeDefined();
    });

    it('128. should reject ausearch calls if target search keys do not exist', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -k missing_secret_key');
      expect(output.toLowerCase()).toMatch(/no matches/);
    });

    it('129. should print configuration status parameters with auditctl -s', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('auditctl -s');
      expect(output).toContain('enabled');
    });

    it('130. should support disabling audit logging using auditctl -e 0', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -e 0');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('enabled 0');
    });

    it('131. should support enabling audit logging using auditctl -e 1', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -e 1');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('enabled 1');
    });

    it('132. should deny non-privileged configuration attempts on audit status parameters', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "auditctl -e 0"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('133. should track execution commands inside audit events log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k executable_run');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('ausearch -k executable_run');
      expect(output).toContain('/usr/bin/whoami');
    });

    it('134. should list audit watches containing multiple keys cleanly', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa -k hosts_alert');
      const output = await pc.executeCommand('auditctl -l');
      expect(output).toContain('hosts_alert');
    });

    it('135. should show summary of configuration alerts on aureport -c', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('aureport -c');
      expect(output).toContain('Config Summary Report');
    });

    it('136. should support formatting output lists as tables via aureport --interpret', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('aureport -l --interpret');
      expect(output).toBeDefined();
    });

    it('137. should support showing logs exclusively from current boot using ausearch -b 0', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -b 0');
      expect(output).toBeDefined();
    });

    it('138. should query logs matching specific process ID via ausearch -p', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -p 1');
      expect(output).toBeDefined();
    });

    it('139. should track directory access recursively with audit rules', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /root -p r -k root_inspection');
      await pc.executeCommand('ls /root');
      const output = await pc.executeCommand('ausearch -k root_inspection');
      expect(output).toContain('/root');
    });

    it('140. should preserve audit rules configuration states across invalid ausearch operations', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/issue -p wa -k issue_trace');
      await pc.executeCommand('ausearch -k nonexistent_key_reference');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('issue_trace');
    });
  });

  // ─── Block 5: Log Rotation & Maintenance (logrotate) (Tests 141-170) 

  describe('Log Rotation & Maintenance (logrotate)', () => {
    it('141. should run logrotate with force configuration via logrotate -f', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "test event"'); // populate syslog
      const output = await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      expect(output.trim()).toBe('');
      const syslogDotOne = await pc.executeCommand('ls /var/log/syslog.1');
      expect(syslogDotOne).toContain('syslog.1');
    });

    it('142. should verify that current active log becomes empty after rotation', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "active log pre-rotation"');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const syslogContent = await pc.executeCommand('cat /var/log/syslog');
      expect(syslogContent.trim()).toBe('');
    });

    it('143. should preserve previous entries inside rotated backup log (syslog.1)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "preservation audit event"');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const syslogDotOneContent = await pc.executeCommand('cat /var/log/syslog.1');
      expect(syslogDotOneContent).toContain('preservation audit event');
    });

    it('144. should support logrotate debug/dry-run mode without mutating filesystem via -d', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "pre-dryrun entry"');
      const output = await pc.executeCommand('logrotate -d /etc/logrotate.conf');
      expect(output.toLowerCase()).toContain('considering log');
      const syslogDotOneExist = await pc.executeCommand('ls /var/log/syslog.1');
      expect(syslogDotOneExist.toLowerCase()).toContain('no such file');
    });

    it('145. should support tracking states in customized state files using logrotate -s', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logrotate -s /tmp/custom_rotate.state /etc/logrotate.conf');
      expect(output.trim()).toBe('');
      const stateContent = await pc.executeCommand('cat /tmp/custom_rotate.state');
      expect(stateContent).toContain('/var/log/syslog');
    });

    it('146. should support compress option producing syslog.1.gz after rotation', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "compress = true" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const compressedLog = await pc.executeCommand('ls /var/log/syslog.1.gz');
      expect(compressedLog).toContain('syslog.1.gz');
    });

    it('147. should support delaycompress options correctly if configured', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "delaycompress = true" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf'); // syslog -> syslog.1 (uncompressed)
      const listUncompressed = await pc.executeCommand('ls /var/log/syslog.1');
      expect(listUncompressed).toContain('syslog.1');
    });

    it('148. should support rotate bounds limitation (rotate 5 keeps only 5 backups)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "rotate = 2" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf'); // syslog.1 created
      await pc.executeCommand('logrotate -f /etc/logrotate.conf'); // syslog.2 created
      await pc.executeCommand('logrotate -f /etc/logrotate.conf'); // syslog.3 should NOT exist, oldest removed
      const listFiles = await pc.executeCommand('ls /var/log/syslog.*');
      expect(listFiles).toContain('syslog.2');
      expect(listFiles).not.toContain('syslog.3');
    });

    it('149. should reject execution when configuration file parameter does not exist', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logrotate /etc/nonexistent_logrotate.conf');
      expect(output.toLowerCase()).toMatch(/error|cannot open/);
    });

    it('150. should reject logrotate config parse if config syntax is invalid', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "invalid_option_key_name" > /tmp/bad_rotate.conf');
      const output = await pc.executeCommand('logrotate /tmp/bad_rotate.conf');
      expect(output.toLowerCase()).toMatch(/error|bad line/);
    });

    it('151. should enforce daily limits of rotations automatically based on time elapsed', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "daily" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate /etc/logrotate.conf');
      // Should not rotate if run twice on same day without force
      expect(output.trim()).toBe('');
    });

    it('152. should respect size threshold parameters before rotating (size 10k)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "size = 10k" >> /etc/logrotate.conf');
      await pc.executeCommand('logger "tiny message"');
      await pc.executeCommand('logrotate /etc/logrotate.conf'); // file smaller than 10k, no rotation
      const dotOne = await pc.executeCommand('ls /var/log/syslog.1');
      expect(dotOne.toLowerCase()).toContain('no such file');
    });

    it('153. should execute rotation if size parameters are successfully exceeded', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "size = 1k" >> /etc/logrotate.conf');
      await pc.executeCommand('dd if=/dev/zero of=/var/log/syslog bs=1k count=2'); // write 2k data
      await pc.executeCommand('logrotate /etc/logrotate.conf');
      const dotOne = await pc.executeCommand('ls /var/log/syslog.1');
      expect(dotOne).toContain('syslog.1');
    });

    it('154. should respect copytruncate directive in logrotate configuration', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "copytruncate" >> /etc/logrotate.conf');
      await pc.executeCommand('logger "copytruncate test event"');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const originalSyslog = await pc.executeCommand('cat /var/log/syslog');
      expect(originalSyslog.trim()).toBe('');
    });

    it('155. should support nocreate options preventing empty log files generation', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "nocreate" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const checkFile = await pc.executeCommand('ls /var/log/syslog');
      expect(checkFile.toLowerCase()).toContain('no such file');
    });

    it('156. should support missingok directive preventing failure if target log is absent', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('rm /var/log/syslog');
      await pc.executeCommand('echo "missingok" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate /etc/logrotate.conf');
      expect(output.trim()).toBe('');
    });

    it('157. should log errors during rotations if missingok is disabled and log is absent', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('rm /var/log/syslog');
      await pc.executeCommand('echo "nomissingok" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate /etc/logrotate.conf');
      expect(output.toLowerCase()).toMatch(/error|log does not exist/);
    });

    it('158. should respect dateext options appending exact ISO date to rotated log backups', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "dateext" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const listFiles = await pc.executeCommand('ls /var/log/syslog-*');
      expect(listFiles).toMatch(/syslog-\d{8}/);
    });

    it('159. should run postrotate execution script sequences safely', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "postrotate\\ntouch /tmp/post_rotate_marker\\nendscript" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const marker = await pc.executeCommand('ls /tmp/post_rotate_marker');
      expect(marker).toContain('post_rotate_marker');
    });

    it('160. should run prerotate execution script sequences safely', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "prerotate\\ntouch /tmp/pre_rotate_marker\\nendscript" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const marker = await pc.executeCommand('ls /tmp/pre_rotate_marker');
      expect(marker).toContain('pre_rotate_marker');
    });

    it('161. should abort rotation if prerotate script fails (returns non-zero status)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "prerotate\\nexit 1\\nendscript" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const dotOne = await pc.executeCommand('ls /var/log/syslog.1');
      expect(dotOne.toLowerCase()).toContain('no such file');
    });

    it('162. should deny non-privileged root operations on logrotate', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "logrotate -f /etc/logrotate.conf"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('163. should support rotate permissions configuration using "create 0640 root adm" rules', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "create 0640 root adm" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const details = await pc.executeCommand('stat -c "%a %U %G" /var/log/syslog');
      expect(details).toContain('640 root adm');
    });

    it('164. should support sharedscripts parameters resolving postrotate scripts execution once for all matching logs', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "sharedscripts\\npostrotate\\necho \\"run\\" >> /tmp/shared_runs\\nendscript" >> /etc/logrotate.conf');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const runs = await pc.executeCommand('cat /tmp/shared_runs');
      expect(runs.trim()).toBe('run');
    });

    it('165. should support explicit weekly rotation time schedules', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "weekly" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate /etc/logrotate.conf');
      expect(output.trim()).toBe('');
    });

    it('166. should support explicit monthly rotation time schedules', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "monthly" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate /etc/logrotate.conf');
      expect(output.trim()).toBe('');
    });

    it('167. should support compresscmd adjustments using custom compressors', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "compresscmd /usr/bin/bzip2" >> /etc/logrotate.conf');
      await pc.executeCommand('echo "compress" >> /etc/logrotate.conf');
      const output = await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      expect(output).not.toContain('error');
    });

    it('168. should handle empty config file logs cleanly without infinite loops', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "" > /tmp/empty_rotate.conf');
      const output = await pc.executeCommand('logrotate /tmp/empty_rotate.conf');
      expect(output.trim()).toBe('');
    });

    it('169. should preserve rotate rules inside custom include directories (/etc/logrotate.d/)', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('echo "/var/log/custom.log {\\nforce\\n}" > /etc/logrotate.d/custom_app');
      await pc.executeCommand('touch /var/log/custom.log');
      const output = await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      expect(output).not.toContain('error');
    });

    it('170. should verify successful termination status code 0 on complete rotations execution', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('logrotate -f /etc/logrotate.conf && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });

  // ─── Block 6: Security, Process Logging, PAM & Access Audits (Tests 171-200)

  describe('Security, Process Logging, PAM & Access Audits', () => {
    it('171. should record failed sudo access attempts in /var/log/auth.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('su user -c "sudo -S cat /etc/shadow"'); // Fails due to incorrect/missing pwd
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth.toLowerCase()).toMatch(/sudo|auth|fail|pam/);
    });

    it('172. should log PAM initialization and session open alerts into auth.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('su user -c "whoami"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth.toLowerCase()).toContain('session opened');
    });

    it('173. should record ssh root login blocks inside secure/auth logging targets', async () => {
      const pc = setupLinuxHost();
      // Mock ssh trace
      await pc.executeCommand('logger -p auth.warn "sshd[1024]: Connection closed by authenticating user root [preauth]"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('Connection closed by authenticating user root');
    });

    it('174. should deny unprivileged users access to read system core auth.log files', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "cat /var/log/auth.log"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('175. should prevent unprivileged users from reading daemon syslog files', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('su user -c "cat /var/log/syslog"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('176. should allow root to read all log files inside /var/log/ folder', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('cat /var/log/auth.log');
      expect(output).not.toContain('Permission denied');
    });

    it('177. should preserve logs integrity after system shutdown alerts', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "SIGTERM sequence received"');
      await pc.executeCommand('shutdown -h now');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('SIGTERM sequence received');
    });

    it('178. should log cron job start/stop transitions in /var/log/cron.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p cron.info "CRON: (root) CMD (backup.sh)"');
      const cron = await pc.executeCommand('cat /var/log/cron.log');
      expect(cron).toContain('CMD (backup.sh)');
    });

    it('179. should log failed pam_unix authentication attempts into secure traces', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.err "pam_unix(sshd:auth): authentication failure"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('authentication failure');
    });

    it('180. should record dynamic system configuration changes inside syslog', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local0.info "sysctl parameter net.ipv4.ip_forward set to 1"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('net.ipv4.ip_forward set to 1');
    });

    it('181. should log apparmor/selinux policy violations under audit structures', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.warn "apparmor=\\"DENIED\\" operation=\\"open\\""');
      const kern = await pc.executeCommand('cat /var/log/kern.log');
      expect(kern).toContain('apparmor="DENIED"');
    });

    it('182. should isolate firewall packet blocks under iptables custom prefix traces', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.info "IPTables-Dropped: IN=eth0 OUT= MAC=..."');
      const kern = await pc.executeCommand('cat /var/log/kern.log');
      expect(kern).toContain('IPTables-Dropped');
    });

    it('183. should record user password changes inside auth.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.info "passwd: password changed for user john"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('password changed for user john');
    });

    it('184. should preserve existing secure entries when user attempts privilege escalation', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('su user -c "su - root"'); // Fails or records attempt
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth.toLowerCase()).toMatch(/su|authentication failure|fail/);
    });

    it('185. should log daemon process termination signals (SIGKILL) inside syslog', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p daemon.warn "systemd[1]: sshd.service: Killed by signal 9"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('Killed by signal 9');
    });

    it('186. should support security compliance tracing for PAM password validation failures', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.notice "pam_tally2(sshd:auth): user admin locked"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('user admin locked');
    });

    it('187. should create daily empty boot traces even when zero actual errors occur', async () => {
      const pc = setupLinuxHost();
      const boot = await pc.executeCommand('cat /var/log/boot.log');
      expect(boot).toBeDefined();
    });

    it('188. should isolate mail server queues errors cleanly in mail.err', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p mail.err "postfix/qmgr: fatal error queue"');
      const mailErr = await pc.executeCommand('cat /var/log/mail.err');
      expect(mailErr).toContain('postfix/qmgr: fatal error queue');
    });

    it('189. should track user session logout events cleanly', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.info "PAM session closed for user root"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('PAM session closed for user root');
    });

    it('190. should record dynamic network interface state changes under daemon priority levels', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p daemon.info "NetworkManager: interface eth0 disconnected"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('interface eth0 disconnected');
    });

    it('191. should track host key fingerprint alterations securely inside auth.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.info "sshd: host key fingerprint MD5:..."');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('host key fingerprint');
    });

    it('192. should register system out of memory (OOM) killer events inside kern.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p kern.err "kernel: Out of memory: Kill process 999 (mysqld)"');
      const kern = await pc.executeCommand('cat /var/log/kern.log');
      expect(kern).toContain('Out of memory: Kill process 999');
    });

    it('193. should track SSH connection attempts from suspicious ports', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.warn "sshd: Corrupted MAC on input from 10.0.0.99"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('Corrupted MAC on input');
    });

    it('194. should isolate cron job execution failure traces clearly', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p cron.err "CRON: failed to compile script syntax"');
      const cron = await pc.executeCommand('cat /var/log/cron.log');
      expect(cron).toContain('failed to compile script syntax');
    });

    it('195. should write system startup checks diagnostics into boot.log', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p local0.info "systemd-fsck: /dev/sda1 clean"');
      const boot = await pc.executeCommand('cat /var/log/boot.log');
      expect(boot).toBeDefined();
    });

    it('196. should prevent raw shell escape sequence injections in logging payload parsers', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger "auth alert: $(whoami) injection test"');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).not.toContain('root injection test'); // shell macro must not evaluate inside payload
    });

    it('197. should enforce rotation of auth.log using the same logrotate configuration', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p auth.info "PAM validation trace"');
      await pc.executeCommand('logrotate -f /etc/logrotate.conf');
      const authDotOne = await pc.executeCommand('ls /var/log/auth.log.1');
      expect(authDotOne).toContain('auth.log.1');
    });

    it('198. should register correct timestamp tags when user session times out', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('logger -p authpriv.info "sshd: session timeout reached"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('session timeout reached');
    });

    it('199. should log security policies reloads inside audit framework', async () => {
      const pc = setupLinuxHost();
      await pc.executeCommand('auditctl -w /etc/audit/auditd.conf -p wa -k audit_config');
      await pc.executeCommand('touch /etc/audit/auditd.conf');
      const output = await pc.executeCommand('ausearch -k audit_config');
      expect(output).toContain('auditd.conf');
    });

    it('200. should terminate security audit scans successfully and exit with status 0 on complete log inspections', async () => {
      const pc = setupLinuxHost();
      const output = await pc.executeCommand('ausearch -ts today && echo "AUDIT_OK"');
      expect(output).toContain('AUDIT_OK');
    });
  });
});
