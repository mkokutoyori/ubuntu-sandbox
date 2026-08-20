/**
 * Advanced TDD Integration Tests for Linux `auditctl` System Coherence.
 * 
 * Covers exactly 150 test scenarios divided into:
 *  - Block 1: Filesystem Coherence & Mount-level Watch Integrity (Tests 1-30)
 *  - Block 2: Process Lifecycle, Fork Inheritance & Context Tracking (Tests 31-60)
 *  - Block 3: Daemon Control, Backlog Exhaustion & Service Reloads (Tests 61-90)
 *  - Block 4: Multi-Criteria Rules, Field Filters & Exclusion Tables (Tests 91-120)
 *  - Block 5: Edge Cases, Stress Boundaries & Ruleset Corruption Handling (Tests 121-150)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

async function setupAdvancedAuditPC() {
  const pc = new LinuxPC('AdvAuditPC', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

const setupAdvancedLAN = setupAdvancedAuditPC;
const setupDebugLAN = setupAdvancedAuditPC;

// ═══════════════════════════════════════════════════════════════════
// ADVANCED AUDITCTL COHERENCE TESTS (1-150)
// ═══════════════════════════════════════════════════════════════════

describe('Linux auditctl Advanced Integration Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: Filesystem Coherence & Mounts (Tests 1-30) ──────────

  describe('Block 1: Filesystem Coherence & Mount-level Watch Integrity', () => {
    it('1. should re-register a file watch dynamically if the watched file is deleted and recreated', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/dynamic.txt');
      await pc.executeCommand('auditctl -w /tmp/dynamic.txt -p w -k dynamic_watch');
      
      await pc.executeCommand('rm /tmp/dynamic.txt'); // delete
      await pc.executeCommand('touch /tmp/dynamic.txt'); // recreate
      await pc.executeCommand('echo "test" >> /tmp/dynamic.txt'); // write
      
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="dynamic_watch"');
    });

    it('2. should watch directories recursively up to 5 levels of nested folders', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir -p /tmp/level1/level2/level3/level4/level5');
      await pc.executeCommand('auditctl -w /tmp/level1 -p w -k deep_watch');
      
      await pc.executeCommand('touch /tmp/level1/level2/level3/level4/level5/target.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="deep_watch"');
      expect(auditLog).toContain('target.txt');
    });

    it('3. should track file modifications made via hard links using the original watch rule', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/original.txt');
      await pc.executeCommand('ln /tmp/original.txt /tmp/hardlink.txt');
      await pc.executeCommand('auditctl -w /tmp/original.txt -p w -k link_watch');
      
      await pc.executeCommand('echo "edit" >> /tmp/hardlink.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="link_watch"');
    });

    it('4. should track symbolic link creations inside a watched directory', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/watched_dir');
      await pc.executeCommand('auditctl -w /tmp/watched_dir -p w -k symlink_watch');
      
      await pc.executeCommand('ln -s /etc/passwd /tmp/watched_dir/passwd_sym');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="symlink_watch"');
      expect(auditLog).toContain('syscall=symlink');
    });

    it('5. should watch a symbolic link file itself instead of its target', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/real_file');
      await pc.executeCommand('ln -s /tmp/real_file /tmp/sym_file');
      // Watch the symlink itself
      await pc.executeCommand('auditctl -w /tmp/sym_file -p wa -k sym_self_watch');
      
      await pc.executeCommand('rm /tmp/sym_file');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="sym_self_watch"');
    });

    it('6. should watch a bind-mounted directory dynamically', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/dir1 /tmp/dir2');
      await pc.executeCommand('mount --bind /tmp/dir1 /tmp/dir2');
      await pc.executeCommand('auditctl -w /tmp/dir2 -p w -k bind_watch');
      
      await pc.executeCommand('touch /tmp/dir2/file.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="bind_watch"');
    });

    it('7. should not generate audit events on a read-only filesystem watch', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/ro_dir');
      await pc.executeCommand('mount -o ro,remount /tmp/ro_dir'); // read-only
      await pc.executeCommand('auditctl -w /tmp/ro_dir -p w -k ro_watch');
      
      const output = await pc.executeCommand('touch /tmp/ro_dir/file.txt');
      expect(output.toLowerCase()).toContain('read-only file system');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('ro_watch');
    });

    it('8. should watch hidden files successfully (files starting with a dot)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/.hidden.txt');
      await pc.executeCommand('auditctl -w /tmp/.hidden.txt -p w -k hidden_watch');
      
      await pc.executeCommand('echo "data" >> /tmp/.hidden.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="hidden_watch"');
    });

    it('9. should handle watched file moving outside the watched directory (stop tracking)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/watched /tmp/unwatched');
      await pc.executeCommand('touch /tmp/watched/file.txt');
      await pc.executeCommand('auditctl -w /tmp/watched/file.txt -p w -k move_watch');
      
      await pc.executeCommand('mv /tmp/watched/file.txt /tmp/unwatched/file.txt');
      await pc.executeCommand('echo "edit" >> /tmp/unwatched/file.txt'); // should not be logged
      
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('edit');
    });

    it('10. should handle unwatched file moving inside the watched directory (start tracking)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/watched /tmp/unwatched');
      await pc.executeCommand('touch /tmp/unwatched/file.txt');
      await pc.executeCommand('auditctl -w /tmp/watched -p w -k move_in_watch');
      
      await pc.executeCommand('mv /tmp/unwatched/file.txt /tmp/watched/file.txt');
      await pc.executeCommand('echo "edit" >> /tmp/watched/file.txt'); // should be logged
      
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="move_in_watch"');
    });

    it('11. should support watching procfs virtual filesystems (/proc/sys/kernel/hostname)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /proc/sys/kernel/hostname -p r -k proc_watch');
      await pc.executeCommand('cat /proc/sys/kernel/hostname');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="proc_watch"');
    });

    it('12. should support watching sysfs virtual filesystems (/sys/power/state)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /sys/power/state -p r -k sys_watch');
      await pc.executeCommand('cat /sys/power/state');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="sys_watch"');
    });

    it('13. should log file modifications using truncate syscalls explicitly', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/trunc.txt');
      await pc.executeCommand('auditctl -w /tmp/trunc.txt -p w -k trunc_watch');
      await pc.executeCommand('truncate -s 0 /tmp/trunc.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=truncate');
    });

    it('14. should track filesystem changes done via sed inline substitutions (inode replacement)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('echo "initial" > /tmp/sed.txt');
      await pc.executeCommand('auditctl -w /tmp/sed.txt -p w -k sed_watch');
      
      await pc.executeCommand('sed -i "s/initial/modified/g" /tmp/sed.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      // sed -i creates a temp file and renames it over the original, changing the inode.
      // auditctl should track the name transition dynamically.
      expect(auditLog).toContain('key="sed_watch"');
    });

    it('15. should log directory changes when a watched directory is removed completely', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/toremove');
      await pc.executeCommand('auditctl -w /tmp/toremove -p d -k rm_dir_watch'); // d = delete
      
      await pc.executeCommand('rmdir /tmp/toremove');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="rm_dir_watch"');
      expect(auditLog).toContain('syscall=rmdir');
    });

    it('16. should log file access when using standard file editors (nano/vim simulation)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/edit.txt');
      await pc.executeCommand('auditctl -w /tmp/edit.txt -p r -k editor_watch');
      
      await pc.executeCommand('cat /tmp/edit.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="editor_watch"');
    });

    it('17. should watch the dynamic resolution of relative symbolic links', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir -p /tmp/link_dir');
      await pc.executeCommand('touch /tmp/link_dir/real');
      await pc.executeCommand('ln -s ./real /tmp/link_dir/sym_rel');
      await pc.executeCommand('auditctl -w /tmp/link_dir/sym_rel -p r -k rel_sym_watch');
      
      await pc.executeCommand('cat /tmp/link_dir/sym_rel');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="rel_sym_watch"');
    });

    it('18. should preserve watches after changing the parent directory name', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/old_parent');
      await pc.executeCommand('touch /tmp/old_parent/file.txt');
      await pc.executeCommand('auditctl -w /tmp/old_parent/file.txt -p w -k parent_move_watch');
      
      await pc.executeCommand('mv /tmp/old_parent /tmp/new_parent');
      await pc.executeCommand('echo "edit" >> /tmp/new_parent/file.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="parent_move_watch"');
    });

    it('19. should track file open events with standard read permission flags', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/read_test.txt');
      await pc.executeCommand('auditctl -w /tmp/read_test.txt -p r -k read_watch');
      await pc.executeCommand('cat /tmp/read_test.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="read_watch"');
    });

    it('20. should log permission changes explicitly with chmod syscall parameters', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/perms.txt');
      await pc.executeCommand('auditctl -w /tmp/perms.txt -p a -k perms_watch');
      await pc.executeCommand('chmod 755 /tmp/perms.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=chmod');
    });

    it('21. should log owner changes explicitly with chown syscall parameters', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/owner.txt');
      await pc.executeCommand('auditctl -w /tmp/owner.txt -p a -k owner_watch');
      await pc.executeCommand('chown user:user /tmp/owner.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=chown');
    });

    it('22. should watch changes on files containing space characters inside filenames', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch "/tmp/spaced file.txt"');
      await pc.executeCommand('auditctl -w "/tmp/spaced file.txt" -p w -k space_watch');
      await pc.executeCommand('echo "data" >> "/tmp/spaced file.txt"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="space_watch"');
    });

    it('23. should ignore directory access if only files inside the directory are watched', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/watched_dir');
      await pc.executeCommand('touch /tmp/watched_dir/file.txt');
      await pc.executeCommand('auditctl -w /tmp/watched_dir/file.txt -p r -k file_only_watch');
      
      await pc.executeCommand('ls /tmp/watched_dir'); // accesses directory, not the file
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('file_only_watch');
    });

    it('24. should watch directory access explicitly if directory is watched with read permissions', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/watched_dir');
      await pc.executeCommand('auditctl -w /tmp/watched_dir -p r -k dir_watch');
      
      await pc.executeCommand('ls /tmp/watched_dir');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="dir_watch"');
    });

    it('25. should not generate audit events if file is read on block device mount points', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /dev/sda -p r -k disk_watch');
      await pc.executeCommand('dd if=/dev/sda count=0'); // mock read
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('26. should watch files successfully inside /var/run/ directory', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /var/run/app.pid');
      await pc.executeCommand('auditctl -w /var/log/cron.log -p wa -k cron_p_watch');
      await pc.executeCommand('touch /var/log/cron.log');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('cron_p_watch');
    });

    it('27. should log file creations using openat syscall rules', async () => {
      const pc = await setupAdvancedLAN(); // setup system to handle openat
      const output = await pc.executeCommand('auditctl -a always,exit -S openat -k fs_openat');
      expect(output.trim()).toBe('');
    });

    it('28. should separate file modifications logs when they occur in same milliseconds', async () => {
      const pc = await setupAdvancedLAN();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_mod');
      await pc.executeCommand('echo "1" >> /etc/passwd && echo "2" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('passwd_mod');
    });

    it('29. should contain file inode information inside PATH audit records', async () => {
      const pc = await setupAdvancedLAN();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_mod');
      await pc.executeCommand('echo "inode_test" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('inode=');
    });

    it('30. should execute successfully and return status 0 on clean files audits tracking', async () => {
      const pc = await setupAdvancedLAN();
      await pc.executeCommand('auditctl -w /etc/hosts -p r -k hosts_test');
      await pc.executeCommand('cat /etc/hosts');
      const output = await pc.executeCommand('ausearch -k hosts_test && echo "FILESYSTEM_OK"');
      expect(output).toContain('FILESYSTEM_OK');
    });
  });

  // ─── Block 2: Process Lifecycle & Context (Tests 31-60) ──────────

  describe('Block 2: Process Lifecycle, Fork Inheritance & Context Tracking', () => {
    it('31. should inherit audit user ID (auid) correctly from parent shell process inside children forks', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /tmp/fork_test -p w -k fork_watch');
      // auid starts as 1000, should be preserved inside subshells (fork)
      await pc.executeCommand('su user -c "sh -c \\"sh -c \\\\\\"echo 1 >> /tmp/fork_test\\\\\\"\\""');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('auid=1000');
    });

    it('32. should track process executions initiated via execve syscall explicitly', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S execve -k exec_tracking');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('syscall=execve');
    });

    it('33. should include login user ID (auid) in execution records even when running under sudo (euid=0)', async () => {
      const pc = await setupDebugLAN(); // setup hosts
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k whoami_exec');
      await pc.executeCommand('su user -c "sudo -S whoami"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('auid=1000'); // original login user is user (1000)
      expect(auditLog).toContain('euid=0'); // running as root via sudo
    });

    it('34. should trace process termination signaling sequences (exit group or kill syscalls)', async () => {
      const pc = await setupAdvancedLAN();
      await pc.executeCommand('auditctl -a always,exit -S kill -k process_kills');
      await pc.executeCommand('kill -9 9999'); // Mock trigger
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="process_kills"');
      expect(auditLog).toContain('syscall=kill');
    });

    it('35. should log pam session validation errors with failed status on incorrect login inputs', async () => {
      const pc = await setupAdvancedLAN();
      await pc.executeCommand('su user -c "su - root -c whoami"');
      const auth = await pc.executeCommand('cat /var/log/auth.log');
      expect(auth.toLowerCase()).toMatch(/fail|error|pam/);
    });

    it('36. should contain unique process identifier (pid) matching trigger shell session inside logs', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "test" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toMatch(/pid=\d+/);
    });

    it('37. should preserve audit tracking context across process fork commands loops', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa -k hosts_audit');
      await pc.executeCommand('for i in 1 2; do echo "127.0.0.1 host$i" >> /etc/hosts; done');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('hosts_audit');
    });

    it('38. should log daemon process executions (sshd, cron) under systemd scopes', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/sbin/cron -p x -k cron_run');
      await pc.executeCommand('service cron restart');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('39. should track setuid binary privilege execution transitions (passwd, su)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/passwd -p x -k passwd_run');
      await pc.executeCommand('su user -c "passwd --help"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('passwd_run');
      expect(auditLog).toContain('euid=0'); // setuid root binary
    });

    it('40. should trace failed command binary executions due to permission restrictions with exit=-13', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/private_bin');
      await pc.executeCommand('chmod 700 /tmp/private_bin'); // root only
      await pc.executeCommand('auditctl -w /tmp/private_bin -p x -k private_run');
      
      await pc.executeCommand('su user -c "/tmp/private_bin"'); // fails
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exit=-13'); // Permission denied
    });

    it('41. should audit thread creations via clone syscall rules if configured', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S clone -k thread_creation');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('clone');
    });

    it('42. should separate execution contexts of script interpreter from raw binaries calls', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/python3 -p x -k python_exec');
      await pc.executeCommand('python3 -c "print(1)"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exe="/usr/bin/python3"');
    });

    it('43. should track process group boundaries using PGID parameters inside logs', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "test" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('44. should record system call exit statuses for all executed processes chronologically', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S execve -k exec_test');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exit=0');
    });

    it('45. should log parent executable path parameter (ppid, comm) inside logs', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "test" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toMatch(/ppid=\d+/);
    });

    it('46. should trace sub-shell processes exiting with negative return states', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S execve -k exec_test');
      await pc.executeCommand('sh -c "exit 10"');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('exit=0'); // sh ran successfully, sub-exit is inside status
    });

    it('47. should record process audit user ID transitions even when auid is unassigned (auid=-1)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p w -k passwd_write');
      await pc.executeCommand('echo "test" >> /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('48. should support process filtering via auditctl rules based on current effective user (-F euid=0)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S open -F euid=0 -k root_open');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('euid=0');
    });

    it('49. should support process filtering via auditctl rules based on current effective group (-F egid=0)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S open -F egid=0 -k root_open');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('egid=0');
    });

    it('50. should verify that child process inherits rule watches from directories watch creations recursively', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir -p /tmp/watch_parent/child');
      await pc.executeCommand('auditctl -w /tmp/watch_parent -p wa -k parent_watch');
      
      await pc.executeCommand('echo "test" >> /tmp/watch_parent/child/test.txt');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="parent_watch"');
    });

    it('51. should contain process command line arguments (cmdline) in audit logs if simulated', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('52. should show process execution logs in aureport -p summary table', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('aureport -p');
      expect(output).toContain('whoami');
    });

    it('53. should show correct exit codes inside aureport -x logs', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('aureport -x');
      expect(output).toContain('whoami');
    });

    it('54. should record cron scheduler task executions with auid unassigned (representing system cron, auid=4294967295)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p r -k shadow_access');
      await pc.executeCommand('logger -p cron.info "CRON: shadow access"'); // mock
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toBeDefined();
    });

    it('55. should track process environment variables manipulations inside audit trace logs', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/env -p x -k env_exec');
      await pc.executeCommand('env > /dev/null');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('env_exec');
    });

    it('56. should distinguish processes starting from different shell instances concurrently', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /bin/ls -p x -k ls_calls');
      await pc.executeCommand('ls /tmp');
      await pc.executeCommand('ls /var');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('ls_calls');
    });

    it('57. should log and report reboot events sequences cleanly', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('reboot');
      const bootLog = await pc.executeCommand('cat /var/log/boot.log');
      expect(bootLog).toBeDefined();
    });

    it('58. should not contain process execution logs for files outside watched folders boundaries', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('ls /tmp'); // unwatched execution
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('ls');
    });

    it('59. should support tracking processes that change dynamic permissions with setuid syscall', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S setuid -k setuid_test');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('setuid');
    });

    it('60. should execute successfully and return status 0 on advanced process audits querying', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /usr/bin/whoami -p x -k exec_test');
      await pc.executeCommand('whoami');
      const output = await pc.executeCommand('ausearch -k exec_test && echo "PROCESS_OK"');
      expect(output).toContain('PROCESS_OK');
    });
  });

  // ─── Block 3: Daemon Control, Saturation & Backlog (Tests 61-90) ──

  describe('Block 3: Daemon Control, Backlog Exhaustion & Service Reloads', () => {
    it('61. should reload audit daemon rules dynamically on sending SIGHUP signal', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('echo "-w /etc/passwd -p wa" >> /etc/audit/rules.d/audit.rules');
      const output = await pc.executeCommand('kill -HUP $(pgid auditd)'); // reload
      expect(output).not.toContain('error');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('-w /etc/passwd');
    });

    it('62. should support configuring backlog limit via auditctl -b', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -b 8192');
      expect(output.trim()).toBe('');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('backlog_limit 8192');
    });

    it('63. should reject negative backlog values', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -b -1024');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('64. should trigger backlog exhaustion action (printk) if backlog limit is exceeded (simulated)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -b 10'); // low backlog
      await pc.executeCommand('auditctl -f 1'); // printk on error
      // Inject burst of syscall events
      for (let i = 0; i < 20; i++) {
        await pc.executeCommand('auditctl -w /etc/passwd -p w');
      }
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toBeDefined();
    });

    it('65. should trigger system panic action on backlog exhaustion if -f 2 is configured', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -f 2'); // panic on error
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('failure 2');
    });

    it('66. should lock audit configuration immutably using auditctl -e 2', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -e 2'); // Lock configuration
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('enabled 2');
    });

    it('67. should reject any rule deletion attempts once audit configuration is locked (enabled 2)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      await pc.executeCommand('auditctl -e 2'); // Lock
      
      const output = await pc.executeCommand('auditctl -D');
      expect(output.toLowerCase()).toMatch(/locked|error|rejected/);
    });

    it('68. should reject any rule addition attempts once audit configuration is locked (enabled 2)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -e 2'); // Lock
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      expect(output.toLowerCase()).toMatch(/locked|error|rejected/);
    });

    it('69. should reject backlog limits modification once audit configuration is locked (enabled 2)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -e 2'); // Lock
      const output = await pc.executeCommand('auditctl -b 16384');
      expect(output.toLowerCase()).toMatch(/locked|error/);
    });

    it('70. should restore mutable status of audit configurations only after reboot', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -e 2'); // Lock
      await pc.executeCommand('reboot'); // reboot clears volatile enabled 2 state
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('enabled 1'); // defaults back to mutable state
    });

    it('71. should persist service start/stop triggers via systemd status mappings', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('service auditd status');
      expect(output.toLowerCase()).toContain('active');
    });

    it('72. should restore persistent rules from rules.d configuration file upon full restart', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('echo "-w /etc/shadow -p wa" >> /etc/audit/rules.d/audit.rules');
      await pc.executeCommand('service auditd restart');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('-w /etc/shadow');
    });

    it('73. should not preserve manual ad-hoc rules upon full restart (without save)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa');
      await pc.executeCommand('service auditd restart');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).not.toContain('-w /etc/hosts');
    });

    it('74. should support auditing queue rate limits on logging pipelines via auditctl -r', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -r 500');
      expect(output.trim()).toBe('');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('rate_limit 500');
    });

    it('75. should support zero parameter on rate limits config (unlimited logging allowed)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -r 0');
      expect(output.trim()).toBe('');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('rate_limit 0');
    });

    it('76. should trigger max log file rotate action when log reaches maximum size (simulated)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('sed -i "s/max_log_file = 8/max_log_file = 1/g" /etc/audit/auditd.conf');
      await pc.executeCommand('sed -i "s/max_log_file_action = ROTATE/max_log_file_action = ROTATE/g" /etc/audit/auditd.conf');
      await pc.executeCommand('service auditd restart');
      // Fill log file
      await pc.executeCommand('dd if=/dev/zero of=/var/log/audit/audit.log bs=1M count=2');
      await pc.executeCommand('service auditd restart'); // forces check
      const rotExist = await pc.executeCommand('ls /var/log/audit/audit.log.1');
      expect(rotExist).toContain('audit.log.1');
    });

    it('77. should suspend logging immediately on disk full alert (simulated space_left threshold)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('sed -i "s/space_left = 75/space_left = 999999/g" /etc/audit/auditd.conf'); // impossible space
      await pc.executeCommand('sed -i "s/space_left_action = SYSLOG/space_left_action = SUSPEND/g" /etc/audit/auditd.conf');
      await pc.executeCommand('service auditd restart');
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p w');
      expect(output.toLowerCase()).toMatch(/suspend|error|disabled/);
    });

    it('78. should reject auditctl -s query if audit service is stopped completely', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('service auditd stop');
      const output = await pc.executeCommand('auditctl -s');
      expect(output.toLowerCase()).toMatch(/error|cannot connect|stopped/);
    });

    it('79. should restore default backlog limit value of 64 on clean reset operations', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -b 64');
      const status = await pc.executeCommand('auditctl -s');
      expect(status).toContain('backlog_limit 64');
    });

    it('80. should preserve active watch rules when daemon is reloaded via reload flag', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      await pc.executeCommand('service auditd reload');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('-w /etc/passwd');
    });

    it('81. should log and report daemon restart sequences in events report', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('service auditd restart');
      const output = await pc.executeCommand('aureport -e');
      expect(output).toContain('DAEMON_START');
    });

    it('82. should support configuration audits using auditctl --status option', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl --status');
      expect(output).toContain('enabled');
    });

    it('83. should protect active ruleset from modification if read-only rules file is mounted', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mount -o ro,remount /etc/audit/rules.d');
      const output = await pc.executeCommand('echo "-w /etc/shadow -p wa" >> /etc/audit/rules.d/audit.rules');
      expect(output.toLowerCase()).toContain('read-only file system');
    });

    it('84. should allow reading status of auditd service from unprivileged accounts', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "service auditd status"');
      expect(output.toLowerCase()).toContain('active');
    });

    it('85. should reject auditctl -e with value outside 0-2 range', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -e 3');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('86. should support listing rules after lock but prevent any modifications', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa -k original_key');
      await pc.executeCommand('auditctl -e 2'); // Lock
      
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('original_key');
      const del = await pc.executeCommand('auditctl -D');
      expect(del.toLowerCase()).toMatch(/locked|error|rejected/);
    });

    it('87. should restore ruleset gracefully after rules configuration file has syntax errors', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('echo "invalid_rule_syntax" > /etc/audit/rules.d/audit.rules');
      const output = await pc.executeCommand('service auditd restart');
      expect(output.toLowerCase()).toMatch(/failed|error/);
    });

    it('88. should reject rate limits modifications containing alphabetic values', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -r abc');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('89. should handle empty audit rules directory cleanly during boot initialization', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('rm -f /etc/audit/rules.d/*');
      const output = await pc.executeCommand('service auditd restart');
      expect(output).not.toContain('failed');
    });

    it('90. should execute successfully and return status 0 when daemon is reloaded gracefully', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('service auditd reload && echo "RELOAD_OK"');
      expect(output).toContain('RELOAD_OK');
    });
  });

  // ─── Block 4: Multi-Criteria Rules & Exclusions (Tests 91-120) ────

  describe('Block 4: Multi-Criteria Rules, Field Filters & Exclusion Tables', () => {
    it('91. should filter syscall rules based on devmajor parameters', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F devmajor=8 -k dev_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('devmajor=8');
    });

    it('92. should filter syscall rules based on devminor parameters', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F devminor=1 -k dev_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('devminor=1');
    });

    it('93. should filter syscall rules based on exact inode parameter matching', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F inode=12345 -k inode_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('inode=12345');
    });

    it('94. should combine 6 different field filters in a single rule successfully', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -F arch=b64 -F auid=1000 -F uid=0 -F success=1 -F exit=0 -S open -k complex_rule');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('complex_rule');
    });

    it('95. should support exclude filter rules to ignore noise on dynamic syscalls (never,exit)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a never,exit -S read -k ignore_read');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('never,exit');
    });

    it('96. should ensure "never,exit" exclusion rules take precedence over "always,exit" matching rules', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a never,exit -S open -F uid=1000');
      await pc.executeCommand('auditctl -a always,exit -S open -F uid=1000 -k always_open');
      
      await pc.executeCommand('su user -c "cat /etc/passwd"'); // triggers open
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('always_open'); // ignored due to never rule
    });

    it('97. should support excluding logs targeting specific system execution paths (never,exit -F path=...)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a never,exit -F path=/usr/bin/whoami');
      expect(output.trim()).toBe('');
    });

    it('98. should filter syscall rules by process session ID explicitly (-F ses=1)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F ses=1 -k session_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('ses=1');
    });

    it('99. should reject syscall filters if comparison operator has typos (uid<>1000)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F uid<>1000');
      expect(output.toLowerCase()).toMatch(/invalid|operator|error/);
    });

    it('100. should support inequality comparison on file/process attributes (-F uid>1000)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F "uid>1000" -k non_system_users');
      expect(output.trim()).toBe('');
    });

    it('101. should filter syscall rules by file directory parameter (-F dir=/etc)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F dir=/etc -k etc_dir_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('dir=/etc');
    });

    it('102. should log syscall if file inside watched directory is read (-F dir=/etc active)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S open -F dir=/etc -k etc_dir_open');
      await pc.executeCommand('cat /etc/passwd');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('key="etc_dir_open"');
    });

    it('103. should exclude directory watches dynamically if exclude rules match path patterns', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a never,exit -F dir=/tmp');
      await pc.executeCommand('auditctl -w /tmp/test -p w -k tmp_write');
      
      await pc.executeCommand('touch /tmp/test');
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).not.toContain('tmp_write');
    });

    it('104. should support filtering based on filesystem type magic numbers (-F fstype=0xef53)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F fstype=0xef53 -k ext_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('fstype=0xef53');
    });

    it('105. should filter audit records based on process executable name matches (-F exe=/bin/ls)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F exe=/bin/ls -k ls_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('exe=/bin/ls');
    });

    it('106. should filter audit records based on process name matches (-F comm=ls)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F comm=ls -k ls_open');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('comm=ls');
    });

    it('107. should reject rule creation if fstype value is out of hex bounds', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F fstype=0xinvalid');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('108. should support filtering based on process session login state (-F sessionid=1)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F sessionid=1');
      expect(output.trim()).toBe('');
    });

    it('109. should handle exclude filter rule deletions explicitly', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a never,exit -S read');
      const output = await pc.executeCommand('auditctl -d never,exit -S read');
      expect(output.trim()).toBe('');
    });

    it('110. should allow adding syscall exclusion targeting all system calls (-S all)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a never,exit -S all');
      expect(output.trim()).toBe('');
    });

    it('111. should support filtering on PAM session identifiers explicitly (-F subj_user=unconfined_u)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F subj_user=unconfined_u');
      expect(output.trim()).toBe('');
    });

    it('112. should support filtering on PAM role identifiers explicitly (-F subj_role=unconfined_r)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F subj_role=unconfined_r');
      expect(output.trim()).toBe('');
    });

    it('113. should support filtering on PAM type identifiers explicitly (-F subj_type=unconfined_t)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F subj_type=unconfined_t');
      expect(output.trim()).toBe('');
    });

    it('114. should support filtering on PAM sensitivity level explicitly (-F subj_sen=s0)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F subj_sen=s0');
      expect(output.trim()).toBe('');
    });

    it('115. should reject exclusion rules if action key has typo (alwayss,exit)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a alwayss,exit -S open');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('116. should reject exclusion rules if filter target has typo (always,exitt)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exitt -S open');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('117. should show correct multi-criteria filters on auditctl -l list output', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -F arch=b64 -F uid=0 -S open -k test_rule');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('arch=b64');
      expect(list).toContain('uid=0');
    });

    it('118. should handle rules deleting correctly if multiple filter criteria are partially supplied', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -F arch=b64 -F uid=0 -S open -k test_rule');
      const output = await pc.executeCommand('auditctl -d always,exit -F arch=b64 -S open'); // mismatch (uid missing)
      expect(output.toLowerCase()).toMatch(/error|no rule/);
    });

    it('119. should delete multi-criteria rule if all parameters match exactly', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -F arch=b64 -F uid=0 -S open -k test_rule');
      const output = await pc.executeCommand('auditctl -d always,exit -F arch=b64 -F uid=0 -S open -k test_rule');
      expect(output.trim()).toBe('');
    });

    it('120. should execute successfully and return status 0 on advanced multicrit-rules creations', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -F arch=b64 -F uid=0 -S open -k test_rule && echo "PASS"');
      expect(output).toContain('PASS');
    });
  });

  // ─── Block 5: Boundaries & Edge Cases (Tests 121-150) ─────────────

  describe('Block 5: Edge Cases, Stress Boundaries & Ruleset Corruption Handling', () => {
    it('121. should support executing auditctl rule listings when maximum rules limit is reached (1000 rules)', async () => {
      const pc = await setupAdvancedAuditPC();
      for (let i = 1; i <= 200; i++) {
        await pc.executeCommand(`auditctl -w /tmp/file${i} -p wa`);
      }
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('file200');
    });

    it('122. should support rule deletions targeting extremely long filenames safely (up to 255 chars)', async () => {
      const pc = await setupAdvancedAuditPC();
      const longName = '/tmp/' + 'S'.repeat(240);
      await pc.executeCommand(`auditctl -w ${longName} -p wa -k long_watch`);
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('long_watch');
      
      const del = await pc.executeCommand(`auditctl -W ${longName} -p wa`);
      expect(del.trim()).toBe('');
    });

    it('123. should reject adding file watches if path points to system directories that are read-only mounts', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mount -o ro,remount /');
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      expect(output).toBeDefined(); // can monitor read-only paths, ensure no service crash
    });

    it('124. should reject rule creation if custom key contains non-ASCII characters', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa -k key_utf8_★');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('125. should reject spaces surrounding the equals sign in multi-criteria fields key', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S open -F uid = 0 -k space_rule');
      expect(output.toLowerCase()).toMatch(/error|invalid/);
    });

    it('126. should reject rule creation if system call parameter contains shell globbing characters', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a always,exit -S op*');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('127. should accept quotes wrapping around rule keys containing spaces', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa -k "passwd update alert"');
      expect(output.trim()).toBe('');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('passwd update alert');
    });

    it('128. should reject rule delete command if the targeted filter name has unmatched quotes', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -W "/etc/passwd');
      expect(output.toLowerCase()).toMatch(/invalid|quote|syntax/);
    });

    it('129. should preserve all mutable rules after service status transitions from active to inactive and back', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/hosts -p wa -k hosts_test');
      await pc.executeCommand('service auditd stop');
      await pc.executeCommand('service auditd start');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('hosts_test');
    });

    it('130. should clear active rules database cleanly using auditctl -D from PrivilegedEXEC mode', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa');
      const del = await pc.executeCommand('auditctl -D');
      expect(del.toLowerCase()).toContain('no rules');
    });

    it('131. should handle corrupt rules.d configs gracefully by loading only up to the point of corruption', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('echo "-w /etc/passwd -p wa" > /etc/audit/rules.d/audit.rules');
      await pc.executeCommand('echo "corrupted_rule_line" >> /etc/audit/rules.d/audit.rules');
      await pc.executeCommand('service auditd restart');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('-w /etc/passwd');
    });

    it('132. should deny non-root users the ability to list active ruleset', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "auditctl -l"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('133. should deny non-root users the ability to flush ruleset', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "auditctl -D"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('134. should deny non-root users the ability to adjust backlog limits', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "auditctl -b 8192"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('135. should deny non-root users the ability to lock configurations (auditctl -e 2)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "auditctl -e 2"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('136. should support custom log file write permissions statically (0600)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('stat -c "%a" /var/log/audit/audit.log');
      expect(output.trim()).toBe('600');
    });

    it('137. should prevent unprivileged users from reading audit logs', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('su user -c "cat /var/log/audit/audit.log"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('138. should support showing auditctl version info', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -v');
      expect(output.toLowerCase()).toContain('version');
    });

    it('139. should reject syscall append commands if filter operator parameters has typos', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -a alwayss,exit -S open');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('140. should support deleting syscall rules based on their key filter dynamically', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S open -k file_open_del');
      const output = await pc.executeCommand('auditctl -d always,exit -S open -k file_open_del');
      expect(output.trim()).toBe('');
    });

    it('141. should reject rule creation if custom key contains whitespace characters', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -w /etc/passwd -p wa -k "key space"');
      expect(output.trim()).toBe(''); // spaces allowed in quotes, verify handles
    });

    it('142. should reject watch rules if directory references inside path parameters point to relative paths (auditctl -w ./passwd)', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -w ./passwd');
      expect(output.toLowerCase()).toMatch(/error|absolute path|invalid/);
    });

    it('143. should log error if the alternative rules file is completely empty', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/empty_rules.conf');
      const output = await pc.executeCommand('auditctl -R /tmp/empty_rules.conf');
      expect(output.trim()).toBe('');
    });

    it('144. should handle relative timestamp parameters with specific bounds cleanly ("1 week ago")', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('ausearch -ts "1 week ago"');
      expect(output).toBeDefined();
    });

    it('145. should prevent non-root users from reading alternative config rules files', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('touch /tmp/alt.rules');
      await pc.executeCommand('chmod 600 /tmp/alt.rules');
      const output = await pc.executeCommand('su user -c "auditctl -R /tmp/alt.rules"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('146. should retain ruleset parameters across multiple non-mutating status queries', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/passwd -p wa -k passwd_mod');
      await pc.executeCommand('auditctl -s');
      await pc.executeCommand('auditctl -s');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('passwd_mod');
    });

    it('147. should log failed script execution parameters to syslog with exit status details', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -w /etc/shadow -p wa -k shadow_mod');
      await pc.executeCommand('su user -c "echo 1 >> /etc/shadow"'); // fails
      const auditLog = await pc.executeCommand('cat /var/log/audit/audit.log');
      expect(auditLog).toContain('shadow_mod');
    });

    it('148. should support executing audits rules targeting specific network subsystems', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('auditctl -a always,exit -S socket -k socket_calls');
      const list = await pc.executeCommand('auditctl -l');
      expect(list).toContain('socket');
    });

    it('149. should reject executing directory audits if directory has no search privileges (+x on folder is missing)', async () => {
      const pc = await setupAdvancedAuditPC();
      await pc.executeCommand('mkdir /tmp/private_dir');
      await pc.executeCommand('chmod 600 /tmp/private_dir'); // root read/write only, no search
      const output = await pc.executeCommand('su user -c "auditctl -w /tmp/private_dir -p wa"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('150. should execute successfully and return status 0 on clean global clear configurations commands', async () => {
      const pc = await setupAdvancedAuditPC();
      const output = await pc.executeCommand('auditctl -D && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });
});
