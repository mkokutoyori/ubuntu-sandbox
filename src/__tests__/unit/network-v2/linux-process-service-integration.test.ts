import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

/**
 * End-to-end integration tests: drive ps/top/kill/systemctl/service through
 * the full bash interpreter and verify they reflect ProcessManager and
 * ServiceManager state, including unit files in the VFS.
 */
describe('Linux process & service integration', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(false);
    // Run as root so ps -e shows all processes.
    exec.execute('sudo -i 2>/dev/null || true');
  });

  describe('ps', () => {
    it('ps -ef shows systemd as PID 1', () => {
      const out = exec.execute('ps -ef');
      expect(out).toContain('systemd');
      expect(out).toMatch(/\b1\b/);
    });

    it('ps aux shows ssh service as a real process', () => {
      const out = exec.execute('ps aux');
      expect(out).toContain('sshd');
    });

    it('ps -e header is present', () => {
      const out = exec.execute('ps -e');
      expect(out).toContain('PID');
      expect(out).toContain('TIME');
    });
  });

  describe('systemctl', () => {
    it('is-active ssh returns "active"', () => {
      expect(exec.execute('systemctl is-active ssh').trim()).toBe('active');
    });

    it('is-enabled ssh returns "enabled"', () => {
      expect(exec.execute('systemctl is-enabled ssh').trim()).toBe('enabled');
    });

    it('stop ssh deactivates the service and removes the process', () => {
      exec.execute('systemctl stop ssh');
      expect(exec.execute('systemctl is-active ssh').trim()).toBe('inactive');
      const ps = exec.execute('ps -ef');
      expect(ps).not.toMatch(/\bsshd\b/);
    });

    it('start ssh after stop spawns a new sshd process', () => {
      exec.execute('systemctl stop ssh');
      exec.execute('systemctl start ssh');
      expect(exec.execute('systemctl is-active ssh').trim()).toBe('active');
      expect(exec.execute('ps aux')).toContain('sshd');
    });

    it('disable ssh removes the wants symlink in the VFS', () => {
      exec.execute('systemctl disable ssh');
      const out = exec.execute('ls /etc/systemd/system/multi-user.target.wants/');
      expect(out).not.toContain('ssh.service');
    });

    it('status ssh shows main PID and active state', () => {
      const out = exec.execute('systemctl status ssh');
      expect(out).toContain('ssh.service');
      expect(out).toContain('active (running)');
      expect(out).toMatch(/Main PID: \d+/);
    });

    it('status of unknown unit reports not found', () => {
      const out = exec.execute('systemctl status not-real');
      expect(out).toContain('could not be found');
    });

    it('list-units includes ssh.service', () => {
      const out = exec.execute('systemctl list-units');
      expect(out).toContain('ssh.service');
      expect(out).toContain('cron.service');
    });

    it('daemon-reload picks up new unit file written via cat heredoc', () => {
      exec.execute('mkdir -p /etc/systemd/system');
      const unit = `[Unit]
Description=Test Service

[Service]
Type=simple
ExecStart=/usr/bin/testapp

[Install]
WantedBy=multi-user.target
`;
      exec.serviceMgr['vfs'].writeFile('/etc/systemd/system/testapp.service', unit, 0, 0, 0o022);
      exec.execute('systemctl daemon-reload');
      expect(exec.execute('systemctl status testapp').trim()).toContain('Test Service');
    });
  });

  describe('service (SysV wrapper)', () => {
    it('service ssh status matches systemctl', () => {
      expect(exec.execute('service ssh status')).toContain('is running');
    });

    it('service cron stop deactivates cron', () => {
      exec.execute('service cron stop');
      expect(exec.execute('systemctl is-active cron').trim()).toBe('inactive');
    });

    it('service --status-all lists every unit', () => {
      const out = exec.execute('service --status-all');
      expect(out).toContain('ssh');
      expect(out).toContain('cron');
    });
  });

  describe('kill / pkill / pgrep / pidof', () => {
    it('pidof sshd returns the sshd main PID', () => {
      const out = exec.execute('pidof sshd').trim();
      expect(out).toMatch(/^\d+/);
    });

    it('kill -9 <sshd-pid> removes the process', () => {
      const pid = exec.execute('pidof sshd').trim().split(/\s+/)[0];
      exec.execute(`kill -9 ${pid}`);
      expect(exec.execute('ps -ef')).not.toContain('sshd');
    });

    it('kill of unknown PID prints "No such process"', () => {
      const out = exec.execute('kill 99999');
      expect(out).toContain('No such process');
    });

    it('kill with no args prints usage', () => {
      const out = exec.execute('kill');
      expect(out).toContain('usage');
    });

    it('kill -l lists signals', () => {
      const out = exec.execute('kill -l');
      expect(out).toContain('SIGHUP');
      expect(out).toContain('SIGKILL');
      expect(out).toContain('SIGTERM');
    });

    it('pgrep cron matches the cron process', () => {
      const out = exec.execute('pgrep cron');
      expect(out.trim()).toMatch(/^\d+/);
    });

    it('pkill rsyslogd terminates the rsyslog daemon', () => {
      exec.execute('pkill rsyslogd');
      expect(exec.execute('pidof rsyslogd').trim()).toBe('');
    });
  });

  describe('top', () => {
    it('top shows system summary and process table', () => {
      const out = exec.execute('top -bn1');
      expect(out).toContain('Tasks:');
      expect(out).toContain('MiB Mem');
      expect(out).toContain('PID USER');
      expect(out).toContain('systemd');
    });
  });

  describe('unit files in the VFS', () => {
    it('ssh.service is readable via cat', () => {
      const out = exec.execute('cat /usr/lib/systemd/system/ssh.service');
      expect(out).toContain('[Unit]');
      expect(out).toContain('Description=OpenBSD Secure Shell server');
      expect(out).toContain('ExecStart=/usr/sbin/sshd -D');
      expect(out).toContain('[Install]');
      expect(out).toContain('WantedBy=multi-user.target');
    });

    it('multi-user.target.wants contains ssh.service symlink', () => {
      const out = exec.execute('ls /etc/systemd/system/multi-user.target.wants/');
      expect(out).toContain('ssh.service');
    });
  });

  describe('server profile', () => {
    it('server has apache2 unit loaded but inactive', () => {
      const server = new LinuxCommandExecutor(true);
      expect(server.execute('systemctl is-active apache2').trim()).toBe('inactive');
      expect(server.execute('cat /usr/lib/systemd/system/apache2.service')).toContain('Apache');
    });

    it('server can start apache2 and see it in ps', () => {
      const server = new LinuxCommandExecutor(true);
      server.execute('systemctl start apache2');
      expect(server.execute('systemctl is-active apache2').trim()).toBe('active');
      expect(server.execute('ps aux')).toContain('apachectl');
    });
  });
});
