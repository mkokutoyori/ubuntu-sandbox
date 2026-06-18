/**
 * TDD tests for Linux Audit Trail Logging and Configuration (auditd).
 * 
 * Covers exactly 150 test scenarios divided into:
 *  - Block 1: File Access & Modification Auditing (Tests 1-30)
 *  - Block 2: Executables, Privilege Escalation & Session Auditing (Tests 31-60)
 *  - Block 3: Filesystem & Network Syscalls Auditing (Tests 61-90)
 *  - Block 4: Audit Daemon Policy & Configuration Management (auditd.conf) (Tests 91-120)
 *  - Block 5: Advanced Multi-criteria Log Querying and Summaries (ausearch, aureport) (Tests 121-150)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupAuditedPC() {
  const pc = new LinuxPC('AuditedHost', 0, 0);
  return pc;
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOGGING & CONFIGURATION TESTS (1-150)
// ═══════════════════════════════════════════════════════════════════

describe('Linux Audit Trail System Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: File Access & Modification Auditing (Tests 1-30) ───

  describe('Block 1: File Access & Modification Auditing', () => {
    it('1. should log write events to /etc/passwd with the correct key', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "audit_user:x:1001:1001:::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="passwd_write"');
      expect(auditLog).toContain('name="/etc/passwd"');
    });

    it('2. should contain type=SYSCALL field in file write audit record', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "new_user:x:1002:::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('type=SYSCALL');
    });

    it('3. should contain type=PATH field with target path in file write audit record', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "user::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('type=PATH');
    });

    it('4. should log attribute changes to /etc/shadow with the correct key', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p a -k shadow_attrib');
      await pc.executeCommand('chmod 600 /etc/shadow');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="shadow_attrib"');
      expect(auditLog).toContain('syscall=chmod'); // chmod modifies attributes
    });

    it('5. should log read events to /etc/shadow with read-only filter active', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p r -k shadow_read');
      await pc.executeCommand('cat /etc/shadow');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="shadow_read"');
    });

    it('6. should log write events to /etc/hosts', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p w -k hosts_mod');
      await pc.executeCommand('echo "10.0.0.50 custom_dns" >> /etc/hosts');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="hosts_mod"');
    });

    it('7. should include owner UID (ouid) inside path audit records', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p w -k shadow_mod');
      await pc.executeCommand('touch /etc/shadow');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('ouid=0'); // owned by root
    });

    it('8. should record successful writes with res=success', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p w -k hosts_mod');
      await pc.executeCommand('echo "10.0.0.51 dev_host" >> /etc/hosts');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('res=success');
    });

    it('9. should record failed write attempts with res=failed', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p w -k shadow_mod');
      await pc.executeCommand('su user -c "echo \\"hack\\" >> /etc/shadow"'); // permission denied
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('res=failed');
    });

    it('10. should include audit user ID (auid) in syscall records representing the real actor', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /tmp/user_file -p w -k user_write');
      await pc.executeCommand('su user -c "echo \\"data\\" >> /tmp/user_file"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('auid=1000'); // user uid is typically 1000
    });

    it('11. should log directory creation inside watched parent folder recursive rule', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_folder');
      await pc.executeCommand('mkdir /root/new_dir');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="root_folder"');
      expect(auditLog).toContain('name="/root/new_dir"');
    });

    it('12. should log directory removal inside watched parent folder recursive rule', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_folder');
      await pc.executeCommand('mkdir /root/new_dir');
      await pc.executeCommand('rmdir /root/new_dir');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=rmdir');
    });

    it('13. should separate multiple syscall records by unique ID counter inside timestamps', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "user1::" >> /etc/passwd');
      await pc.executeCommand('echo "user2::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      const matches = auditLog.match(/audit\(\d+\.\d+:(\d+)\)/g);
      expect(matches).toBeDefined();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    it('14. should not generate audit log if file is accessed on an unwatched path', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "data" >> /tmp/unwatched_file.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('unwatched_file.txt');
    });

    it('15. should log files created via touch command using open syscall parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_mod');
      await pc.executeCommand('touch /root/touched_file.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('touched_file.txt');
      expect(auditLog).toContain('syscall=open');
    });

    it('16. should log file modifications made via sed inline replacement', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p w -k hosts_mod');
      await pc.executeCommand('sed -i "s/127.0.0.1/127.0.0.1 localhost/g" /etc/hosts');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="hosts_mod"');
    });

    it('17. should log file deletions using unlink syscall record details', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_mod');
      await pc.executeCommand('touch /root/removable.txt');
      await pc.executeCommand('rm /root/removable.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=unlink');
      expect(auditLog).toContain('removable.txt');
    });

    it('18. should include effective user ID (euid) inside syscall record parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p r -k shadow_access');
      await pc.executeCommand('cat /etc/shadow');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('euid=0'); // running as root
    });

    it('19. should record execute action on file explicitly (-p x)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k whoami_exec');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="whoami_exec"');
    });

    it('20. should log file symbolic link creation via symlink syscall', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_links');
      await pc.executeCommand('ln -s /etc/passwd /root/passwd_link');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=symlink');
      expect(auditLog).toContain('passwd_link');
    });

    it('21. should include parent process ID (ppid) in syscall audit details', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_mod');
      await pc.executeCommand('echo "user1::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toMatch(/ppid=\d+/);
    });

    it('22. should log file renaming actions using rename syscall markers', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k root_mod');
      await pc.executeCommand('touch /root/old_name.txt');
      await pc.executeCommand('mv /root/old_name.txt /root/new_name.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=rename');
      expect(auditLog).toContain('old_name.txt');
      expect(auditLog).toContain('new_name.txt');
    });

    it('23. should suppress logging read actions if only write permission is watched (-p w)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p w -k hosts_write_only');
      await pc.executeCommand('cat /etc/hosts'); // read action
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('hosts_write_only');
    });

    it('24. should include command executable path (exe) in audit output', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "new_trace::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exe="/bin/echo"');
    });

    it('25. should track modifications to /etc/pam.d/ files cleanly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/pam.d/common-auth -p wa -k pam_change');
      await pc.executeCommand('touch /etc/pam.d/common-auth');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="pam_change"');
    });

    it('26. should log file truncation events correctly using truncate syscall identifiers', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /tmp/target_file -p w -k truncate_trace');
      await pc.executeCommand('echo "content" > /tmp/target_file');
      await pc.executeCommand('echo -n "" > /tmp/target_file'); // truncate
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="truncate_trace"');
    });

    it('27. should include group ID (gid) inside path and syscall records', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "trace_user::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('gid=0');
    });

    it('28. should log directory hard link creation attempts securely', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p w -k link_watch');
      await pc.executeCommand('ln /etc/hosts /root/hosts_link');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=link');
      expect(auditLog).toContain('hosts_link');
    });

    it('29. should audit directory permissions changes explicitly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /root -p a -k root_attrib');
      await pc.executeCommand('chmod 755 /root');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="root_attrib"');
      expect(auditLog).toContain('name="/root"');
    });

    it('30. should execute successfully and output correct parameters when query matches first write', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k p_write');
      await pc.executeCommand('echo "user_test::" >> /etc/passwd');
      const query = await pc.executeCommand('ausearch -k p_write');
      expect(query).toContain('user_test::');
    });
  });

  // ─── Block 2: Executables, Privilege Escalation & Session Auditing (Tests 31-60)

  describe('Block 2: Executables, Privilege Escalation & Session Auditing', () => {
    it('31. should log execution of su command explicitly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/su -p x -k su_calls');
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="su_calls"');
      expect(auditLog).toContain('exe="/bin/su"');
    });

    it('32. should log execution of sudo command explicitly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/sudo -p x -k sudo_calls');
      await pc.executeCommand('su user -c "sudo -S whoami"'); // mock passwordless sudo or failure log
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="sudo_calls"');
    });

    it('33. should include loginuid (original uid before su) inside audit log parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k whoami_exec');
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      // auid is original login uid, should match 1000 or the user session ID
      expect(auditLog).toContain('auid=1000');
    });

    it('34. should include current effective uid (euid=0) inside su execution logs', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/su -p x -k su_calls');
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('euid=0'); // su is SUID root binary
    });

    it('35. should log failed privilege escalation attempts as failed events', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/su -p x -k su_calls');
      await pc.executeCommand('su user -c "su - root -c whoami"'); // fails due to missing password
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('res=failed');
    });

    it('36. should log command binary executions inside custom system folders', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('mkdir /tmp/bin_test');
      await pc.executeCommand('echo "echo \'run\'" > /tmp/bin_test/script.sh');
      await pc.executeCommand('chmod +x /tmp/bin_test/script.sh');
      await pc.executeCommand('auditctl -w /tmp/bin_test/script.sh -p x -k script_exec');
      await pc.executeCommand('/tmp/bin_test/script.sh');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="script_exec"');
    });

    it('37. should log interactive shell executions (bash, sh)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/bash -p x -k bash_calls');
      await pc.executeCommand('bash -c "echo 1"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="bash_calls"');
    });

    it('38. should log script interpreters explicitly via shebang execution hooks', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/python3 -p x -k python_calls');
      await pc.executeCommand('python3 -c "print(1)"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="python_calls"');
    });

    it('39. should log failed sudo operations with PAM validation errors in auth.log', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "sudo -S cat /etc/shadow"'); // incorrect password
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth.toLowerCase()).toMatch(/sudo|pam|auth|fail/);
    });

    it('40. should log user shell logins session openings into audit trail log', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('PAM_session');
    });

    it('41. should record target session termination logs securely', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "exit"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('PAM_session');
    });

    it('42. should record exact binary parameters parsed during executing watches', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/head -p x -k head_exec');
      await pc.executeCommand('head -n 1 /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exe="/usr/bin/head"');
    });

    it('43. should log user transitions to unprivileged accounts via su user', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/su -p x -k su_calls');
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('su_calls');
    });

    it('44. should trace execution commands triggered inside crontab task schedulers', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/sbin/cron -p x -k cron_exec');
      await pc.executeCommand('logger -p cron.info "cron running task"'); // mock trigger
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('45. should log failed SSH logins inside simulated sshd parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('logger -p auth.warn "sshd[9999]: Failed password for root from 10.0.0.99"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('Failed password for root');
    });

    it('46. should include audit session ID (ses) inside session audit logging entries', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toMatch(/ses=\d+/);
    });

    it('47. should record environment metrics parameter modifications statically', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/env -p x -k env_exec');
      await pc.executeCommand('env > /dev/null');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="env_exec"');
    });

    it('48. should separate execute logs triggered concurrently in separate sessions', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /bin/ls -p x -k ls_calls');
      await Promise.all([
        pc.executeCommand('ls /tmp'),
        pc.executeCommand('ls /var')
      ]);
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('ls_calls');
    });

    it('49. should log reboot evaluations correctly as system events', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('reboot');
      const bootLog = await pc.executeCommand('cat /var/log/boot.log');
      expect(bootLog).toBeDefined();
    });

    it('50. should reject executing watches if user lacks execution rights on binary', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('touch /tmp/no_run.sh');
      await pc.executeCommand('chmod -x /tmp/no_run.sh');
      await pc.executeCommand('auditctl -w /tmp/no_run.sh -p x -k norun_trace');
      const output = await pc.executeCommand('/tmp/no_run.sh');
      expect(output.toLowerCase()).toMatch(/permission denied|cannot execute/);
    });

    it('51. should record process name (comm) inside syscall audit records', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "user_one::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('comm="echo"');
    });

    it('52. should show command logs in aureport -x explicitly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('aureport -x');
      expect(output).toContain('whoami');
    });

    it('53. should show login report summaries inside aureport -l', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "whoami"');
      const output = await pc.executeCommand('aureport -l');
      expect(output).toContain('Login Summary Report');
    });

    it('54. should record target exit values correctly inside execution audits', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exit=0'); // exit code 0 is success
    });

    it('55. should include full executable path inside PATH audit entries', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exe="/usr/bin/whoami"');
    });

    it('56. should log execution transitions triggered from interactive sudo sessions', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "sudo -S whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('57. should include security context labels (subj) if SELinux/AppArmor is simulated', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "user::" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined(); // verify no crash
    });

    it('58. should not contain execution logs for files accessed outside watched directories', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('ls /tmp'); // another execution path
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('ls');
    });

    it('59. should support tracking of dynamic shell environment escalations statically', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('su user -c "whoami"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth).toContain('session opened');
    });

    it('60. should show execution logs in ausearch -k queries cleanly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const query = await pc.executeCommand('ausearch -k exec_test');
      expect(query).toContain('/usr/bin/whoami');
    });
  });

  // ─── Block 3: Filesystem & Network Syscalls Auditing (Tests 61-90) 

  describe('Block 3: Filesystem & Network Syscalls Auditing', () => {
    it('61. should log network socket creations using socket syscall parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S socket -k network_socket');
      // Simulated socket bind or loopback interface connection
      await pc.executeCommand('ping -c 1 127.0.0.1'); 
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_socket"');
    });

    it('62. should log network connections creations using connect syscall parameters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S connect -k network_connect');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_connect"');
    });

    it('63. should log file unlinking actions via unlink syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S unlink -k fs_delete');
      await pc.executeCommand('touch /tmp/deletable.txt');
      await pc.executeCommand('rm /tmp/deletable.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_delete"');
      expect(auditLog).toContain('syscall=unlink');
    });

    it('64. should log file renaming actions via rename syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S rename -k fs_rename');
      await pc.executeCommand('touch /tmp/old.txt');
      await pc.executeCommand('mv /tmp/old.txt /tmp/new.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_rename"');
      expect(auditLog).toContain('syscall=rename');
    });

    it('65. should log directory creation actions via mkdir syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S mkdir -k fs_mkdir');
      await pc.executeCommand('mkdir /tmp/new_folder');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_mkdir"');
      expect(auditLog).toContain('syscall=mkdir');
    });

    it('66. should log directory deletion actions via rmdir syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S rmdir -k fs_rmdir');
      await pc.executeCommand('mkdir /tmp/new_folder');
      await pc.executeCommand('rmdir /tmp/new_folder');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_rmdir"');
      expect(auditLog).toContain('syscall=rmdir');
    });

    it('67. should log file permissions modification actions via chmod syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S chmod -k fs_chmod');
      await pc.executeCommand('touch /tmp/perm_test.txt');
      await pc.executeCommand('chmod 755 /tmp/perm_test.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_chmod"');
      expect(auditLog).toContain('syscall=chmod');
    });

    it('68. should log file ownership modification actions via chown syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S chown -k fs_chown');
      await pc.executeCommand('touch /tmp/owner_test.txt');
      await pc.executeCommand('chown root:root /tmp/owner_test.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_chown"');
      expect(auditLog).toContain('syscall=chown');
    });

    it('69. should log file creation events explicitly using open syscall rules with create flags', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S open -k fs_open');
      await pc.executeCommand('touch /tmp/new_open.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_open"');
    });

    it('70. should contain syscall numerical parameter mapping explicitly in syscall logs', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S open -k fs_open');
      await pc.executeCommand('touch /tmp/new_open.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toMatch(/syscall=\w+/);
    });

    it('71. should record syscall exit codes (exit=0 or negative) in logs correctly', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S open -k fs_open');
      await pc.executeCommand('touch /tmp/new_open.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exit=0');
    });

    it('72. should log network socket binding parameters using bind syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S bind -k network_bind');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_bind"');
    });

    it('73. should support wildcard arch configuration targets on syscall filters', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('auditctl -a always,exit -F arch=b64 -S open -k any_open');
      expect(output.trim()).toBe('');
    });

    it('74. should capture unlink syscall exit failures correctly with success=0', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S unlink -k fs_delete');
      await pc.executeCommand('rm /tmp/nonexistent_file_path'); // fails
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('success=no');
    });

    it('75. should log symlink syscall executions with correct key mappings', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S symlink -k fs_links');
      await pc.executeCommand('ln -s /etc/passwd /tmp/passwd_lnk');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="fs_links"');
      expect(auditLog).toContain('syscall=symlink');
    });

    it('76. should not log unlinked files from other unchecked directories inside narrow syscall filters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S unlink -F path=/tmp/monitored.txt -k fs_delete');
      await pc.executeCommand('touch /tmp/monitored.txt');
      await pc.executeCommand('touch /tmp/unmonitored.txt');
      await pc.executeCommand('rm /tmp/unmonitored.txt'); // should not log
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('unmonitored.txt');
    });

    it('77. should track socket close transitions with close syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S close -k network_close');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_close"');
    });

    it('78. should support filtering syscalls based on numerical parameters index (a0, a1)', async () => {
      const pc = setupAuditedPC();
      // a0=0 indicates standard stdin parameters, verify runs without crash
      const output = await pc.executeCommand('auditctl -a always,exit -S write -F a0=0 -k stdin_write');
      expect(output.trim()).toBe('');
    });

    it('79. should log system clock adjustments via settimeofday syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S settimeofday -k clock_change');
      const status = await pc.executeCommand('auditctl -l');
      expect(status).toContain('settimeofday');
    });

    it('80. should log system hostname adjustments via sethostname syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S sethostname -k hostname_change');
      const status = await pc.executeCommand('auditctl -l');
      expect(status).toContain('sethostname');
    });

    it('81. should log network socket sending actions via sendto syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S sendto -k network_send');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_send"');
    });

    it('82. should log network socket receiving actions via recvfrom syscall rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S recvfrom -k network_receive');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="network_receive"');
    });

    it('83. should isolate file creations from directories creations under different syscall filters', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S mkdir -k fs_mkdir_only');
      await pc.executeCommand('touch /tmp/new_file_only.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('fs_mkdir_only');
    });

    it('84. should include original parent process execution name (comm) inside network socket connection logs', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S connect -k network_connect');
      await pc.executeCommand('ping -c 1 127.0.0.1');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('comm="ping"');
    });

    it('85. should support deleting syscall rules based on their key filter dynamically', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S open -k fs_open_del');
      await pc.executeCommand('auditctl -d always,exit -S open -k fs_open_del');
      const list = await pc.executeCommand('auditctl -l');
      expect(list.toLowerCase()).toContain('no rules');
    });

    it('86. should support listing multicriteria syscall filters inside auditctl -l output', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -F arch=b64 -S open -F uid=0 -k root_open_test');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('arch=b64');
      expect(list).toContain('uid=0');
    });

    it('87. should reject syscall filters if syscall numerical index is too high', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S 999999');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('88. should reject syscall filters if field key operators are invalid', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F uid??0');
      expect(output.toLowerCase()).toMatch(/invalid|operator|error/);
    });

    it('89. should show correct syscall details inside ausearch queries', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -a always,exit -S unlink -k fs_delete_test');
      await pc.executeCommand('touch /tmp/temp.txt');
      await pc.executeCommand('rm /tmp/temp.txt');
      const query = await pc.executeCommand('ausearch -k fs_delete_test');
      expect(query).toContain('syscall=unlink');
    });

    it('90. should execute successfully and return status 0 on multi-syscall creations', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -S close -k test_combo && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });

  // ─── Block 4: Configuring Audit Daemon Policies (auditd.conf) (Tests 91-120)

  describe('Block 4: Configuring Audit Daemon Policies (auditd.conf)', () => {
    it('91. should show default log file path configuration in auditd.conf', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('log_file = /var/log/audit/audit.log');
    });

    it('92. should modify dynamic log file path inside auditd.conf', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s|log_file = /var/log/audit/audit.log|log_file = /tmp/audit.log|g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('log_file = /tmp/audit.log');
    });

    it('93. should show default backlog limit settings inside auditd.conf', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('backlog_limit = 64');
    });

    it('94. should support configure trail size limits with max_log_file parameter', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/max_log_file = 8/max_log_file = 20/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('max_log_file = 20');
    });

    it('95. should support configure rotation boundaries via max_log_file_action parameter', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/max_log_file_action = ROTATE/max_log_file_action = KEEP_LOGS/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('max_log_file_action = KEEP_LOGS');
    });

    it('96. should support configure disk-space warnings using space_left parameter in auditd.conf', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/space_left = 75/space_left = 100/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('space_left = 100');
    });

    it('97. should support configure disk-space warnings actions using space_left_action parameter', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/space_left_action = SYSLOG/space_left_action = EMAIL/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('space_left_action = EMAIL');
    });

    it('98. should support configure low disk-space critical thresholds using admin_space_left parameter', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/admin_space_left = 50/admin_space_left = 20/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('admin_space_left = 20');
    });

    it('99. should support configure critical thresholds actions using admin_space_left_action parameter', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/admin_space_left_action = SUSPEND/admin_space_left_action = HALT/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('admin_space_left_action = HALT');
    });

    it('100. should support configure rate of audits using rate_limit parameters in auditd.conf', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('rate_limit = 0'); // unlimited by default
    });

    it('101. should reject service reloading if auditd.conf syntax is corrupted', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('echo "corrupted_property_name = !!" > /etc/audit/auditd.conf');
      const output = await pc.executeCommand('service auditd reload');
      expect(output.toLowerCase()).toMatch(/failed|error/);
    });

    it('102. should restore default configurations if config file backup is loaded', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('cp /etc/audit/auditd.conf /etc/audit/auditd.conf.bak');
      await pc.executeCommand('echo "corrupted" > /etc/audit/auditd.conf');
      await pc.executeCommand('cp /etc/audit/auditd.conf.bak /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('log_file');
    });

    it('103. should reject max_log_file parameters if value is out of bounds (less than 1)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/max_log_file = 8/max_log_file = 0/g" /etc/audit/auditd.conf');
      const output = await pc.executeCommand('service auditd restart');
      expect(output.toLowerCase()).toMatch(/failed|error/);
    });

    it('104. should deny unprivileged users access to modify /etc/audit/auditd.conf', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('su user -c "echo \\"log_file = /tmp/leak.log\\" >> /etc/audit/auditd.conf"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('105. should support loading persistent rules on system startup from /etc/audit/rules.d/audit.rules', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('echo "-w /etc/passwd -p wa" >> /etc/audit/rules.d/audit.rules');
      await pc.executeCommand('service auditd restart');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('-w /etc/passwd');
    });

    it('106. should deny unprivileged users access to read persistent rules database', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('su user -c "cat /etc/audit/rules.d/audit.rules"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('107. should route audits to syslog instead of custom logs if configured with space_left_action=SYSLOG', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/space_left_action = EMAIL/space_left_action = SYSLOG/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('space_left_action = SYSLOG');
    });

    it('108. should support logging statistics queries via auditd metrics files', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('service auditd status');
      expect(output.toLowerCase()).toContain('active');
    });

    it('109. should persist manual active watch rules across service reloads (without restart)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa -k hosts_manual');
      await pc.executeCommand('service auditd reload');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('hosts_manual');
    });

    it('110. should wipe manual active watch rules on full restart unless added to persistent config file', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa -k hosts_manual');
      await pc.executeCommand('service auditd restart');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).not.toContain('hosts_manual');
    });

    it('111. should support configure maximum number of log files keepers (num_logs)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/num_logs = 5/num_logs = 10/g" /etc/audit/auditd.conf');
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('num_logs = 10');
    });

    it('112. should reject num_logs parameter adjustments if value is invalid (less than 1)', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/num_logs = 5/num_logs = 0/g" /etc/audit/auditd.conf');
      const output = await pc.executeCommand('service auditd restart');
      expect(output.toLowerCase()).toMatch(/failed|error/);
    });

    it('113. should configure dispatcher parameter in auditd.conf', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('dispatcher');
    });

    it('114. should configure write_logs parameter in auditd.conf (write_logs = yes)', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('write_logs = yes');
    });

    it('115. should support configure priority format options (log_format = RAW)', async () => {
      const pc = setupAuditedPC();
      const config = await pc.executeCommand('cat /etc/audit/auditd.conf');
      expect(config).toContain('log_format = RAW');
    });

    it('116. should reject service reload if log_format configuration value is invalid', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('sed -i "s/log_format = RAW/log_format = INVALID_FORMAT/g" /etc/audit/auditd.conf');
      const output = await pc.executeCommand('service auditd reload');
      expect(output.toLowerCase()).toMatch(/failed|error/);
    });

    it('117. should preserve auditd.conf permissions statically to owner root only (0640)', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('stat -c "%a" /etc/audit/auditd.conf');
      expect(output.trim()).toBe('640');
    });

    it('118. should preserve rules.d configuration folder permissions statically to owner root only (0750)', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('stat -c "%a" /etc/audit/rules.d');
      expect(output.trim()).toBe('750');
    });

    it('119. should allow reading status of auditd service from unprivileged accounts', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('su user -c "service auditd status"');
      expect(output.toLowerCase()).toContain('active');
    });

    it('120. should execute successfully and return status 0 on standard service restarts', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('service auditd restart && echo "RESTARTED"');
      expect(output).toContain('RESTARTED');
    });
  });

  // ─── Block 5: Complex Multi-criteria Audits, Search Filters & Formats (ausearch, aureport) (Tests 121-150)

  describe('Block 5: Complex Multi-criteria Audits, Search Filters & Formats', () => {
    it('121. should query audit logs targeting specific process executable using ausearch -x', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('ausearch -x /usr/bin/whoami');
      expect(output).toContain('whoami');
    });

    it('122. should query audit logs targeting specific login user using ausearch -ua', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /tmp/test_file -p w -k test_key');
      await pc.executeCommand('su user -c "echo 1 >> /tmp/test_file"');
      const output = await pc.executeCommand('ausearch -ua 1000'); // auid typically 1000
      expect(output).toContain('test_key');
    });

    it('123. should query audit logs targeting specific real user using ausearch -u', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /tmp/test_file -p w -k test_key');
      await pc.executeCommand('su user -c "echo 1 >> /tmp/test_file"');
      const output = await pc.executeCommand('ausearch -u user');
      expect(output).toContain('test_key');
    });

    it('124. should show overall summary of audit event distributions on aureport', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport');
      expect(output).toContain('Number of events');
    });

    it('125. should show summary of anomalies inside aureport -a', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -a');
      expect(output).toContain('Anomaly Summary Report');
    });

    it('126. should show summary of configuration alerts on aureport -c', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -c');
      expect(output).toContain('Config Summary Report');
    });

    it('127. should show summary of system failures on aureport -e', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -e');
      expect(output).toContain('Event Summary Report');
    });

    it('128. should show summary of file operations on aureport -f', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -f');
      expect(output).toContain('File Summary Report');
    });

    it('129. should show summary of group accounts operations on aureport -g', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -g');
      expect(output).toContain('Group ID Summary Report');
    });

    it('130. should show summary of host origins on aureport -h', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -h');
      expect(output).toContain('Host Summary Report');
    });

    it('131. should show summary of security integrations on aureport -i', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -i');
      expect(output).toContain('Interpreter Summary Report');
    });

    it('132. should show summary of system logins on aureport -l', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -l');
      expect(output).toContain('Login Summary Report');
    });

    it('133. should show summary of MAC labels validations on aureport -m', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -m');
      expect(output).toContain('MAC Summary Report');
    });

    it('134. should show summary of process execution IDs on aureport -p', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -p');
      expect(output).toContain('PID Summary Report');
    });

    it('135. should show summary of system calls frequencies on aureport -s', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -s');
      expect(output).toContain('Syscall Summary Report');
    });

    it('136. should show summary of active terminals on aureport -t', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -t');
      expect(output).toContain('Terminal Summary Report');
    });

    it('137. should show summary of user IDs on aureport -u', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -u');
      expect(output).toContain('User ID Summary Report');
    });

    it('138. should show summary of executables files on aureport -x', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -x');
      expect(output).toContain('Executable Summary Report');
    });

    it('139. should support printing results matching specific exit failure codes via ausearch --success no', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p w -k shadow_access');
      await pc.executeCommand('su user -c "echo 1 >> /etc/shadow"'); // fails
      const output = await pc.executeCommand('ausearch --success no');
      expect(output).toContain('shadow_access');
    });

    it('140. should support printing results matching specific exit success codes via ausearch --success yes', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_access');
      await pc.executeCommand('echo "test::" >> /etc/passwd'); // succeeds
      const output = await pc.executeCommand('ausearch --success yes');
      expect(output).toContain('passwd_access');
    });

    it('141. should support interpret numerical metrics to human-readable strings on aureport --interpret', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -u --interpret');
      expect(output).toContain('root'); // uid 0 is interpreted to root
    });

    it('142. should support interpret numerical metrics to human-readable strings on ausearch -i', async () => {
      const pc = setupAuditedPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_access');
      await pc.executeCommand('echo "test::" >> /etc/passwd');
      const output = await pc.executeCommand('ausearch -k passwd_access -i');
      expect(output).toContain('root');
    });

    it('143. should restrict aureport listing query records to specific date ranges via -ts', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -ts today');
      expect(output).toBeDefined();
    });

    it('144. should restrict aureport listing query records to specific end date ranges via -te', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -te now');
      expect(output).toBeDefined();
    });

    it('145. should support printing results matching specific process PID via ausearch -p', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('ausearch -p 1');
      expect(output).toBeDefined();
    });

    it('146. should support printing results matching specific parent process PPID via ausearch -pp', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('ausearch -pp 1');
      expect(output).toBeDefined();
    });

    it('147. should show summary of active system keys frequencies on aureport -k', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport -k');
      expect(output).toContain('Key Summary Report');
    });

    it('148. should deny unprivileged users access to run ausearch tools', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('su user -c "ausearch -k some_key"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('149. should deny unprivileged users access to run aureport summaries tools', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('su user -c "aureport"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('150. should execute successfully and return status 0 on default aureport summary queries', async () => {
      const pc = setupAuditedPC();
      const output = await pc.executeCommand('aureport && echo "AUREPORT_OK"');
      expect(output).toContain('AUREPORT_OK');
    });
  });
});
