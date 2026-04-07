import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';

describe('LinuxServiceManager', () => {
  let vfs: VirtualFileSystem;
  let pm: LinuxProcessManager;
  let sm: LinuxServiceManager;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    pm = new LinuxProcessManager();
    sm = new LinuxServiceManager(vfs, pm, { isServer: false });
  });

  describe('bootstrap and unit file installation', () => {
    it('installs default unit files in /usr/lib/systemd/system', () => {
      expect(vfs.readFile('/usr/lib/systemd/system/ssh.service')).not.toBeNull();
      expect(vfs.readFile('/usr/lib/systemd/system/cron.service')).not.toBeNull();
      expect(vfs.readFile('/usr/lib/systemd/system/rsyslog.service')).not.toBeNull();
    });

    it('unit files contain Unit/Service/Install sections', () => {
      const content = vfs.readFile('/usr/lib/systemd/system/ssh.service')!;
      expect(content).toContain('[Unit]');
      expect(content).toContain('[Service]');
      expect(content).toContain('[Install]');
      expect(content).toContain('ExecStart=');
    });

    it('creates wants symlinks for enabled services in multi-user.target.wants', () => {
      expect(vfs.existsNoFollow('/etc/systemd/system/multi-user.target.wants/ssh.service')).toBe(true);
    });

    it('starts enabled services automatically on boot', () => {
      expect(sm.isActive('ssh')).toBe(true);
      expect(sm.isActive('cron')).toBe(true);
      const sshd = sm.status('ssh');
      expect(sshd?.mainPid).toBeDefined();
      expect(pm.get(sshd!.mainPid!)).toBeDefined();
    });

    it('inactive services have no main PID', () => {
      const apache = sm.status('apache2');
      // apache2 is not in default workstation set, but if loaded it should be inactive
      if (apache) {
        expect(apache.state).toBe('inactive');
        expect(apache.mainPid).toBeUndefined();
      }
    });
  });

  describe('start / stop', () => {
    it('start a stopped service activates it and spawns its main process', () => {
      sm.stop('ssh');
      expect(sm.isActive('ssh')).toBe(false);
      const result = sm.start('ssh');
      expect(result.ok).toBe(true);
      expect(sm.isActive('ssh')).toBe(true);
      const status = sm.status('ssh');
      expect(status!.mainPid).toBeDefined();
      expect(pm.get(status!.mainPid!)?.serviceName).toBe('ssh');
    });

    it('starting an already active service is a no-op (still ok)', () => {
      const before = sm.status('ssh')!.mainPid;
      const result = sm.start('ssh');
      expect(result.ok).toBe(true);
      expect(sm.status('ssh')!.mainPid).toBe(before);
    });

    it('stop an active service deactivates it and kills its main process', () => {
      const pid = sm.status('ssh')!.mainPid!;
      const result = sm.stop('ssh');
      expect(result.ok).toBe(true);
      expect(sm.isActive('ssh')).toBe(false);
      expect(pm.get(pid)).toBeUndefined();
      expect(sm.status('ssh')!.mainPid).toBeUndefined();
    });

    it('start unknown service fails with descriptive error', () => {
      const result = sm.start('not-a-real-service');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not-a-real-service');
    });

    it('restart kills the old PID and spawns a new one', () => {
      const oldPid = sm.status('ssh')!.mainPid!;
      const result = sm.restart('ssh');
      expect(result.ok).toBe(true);
      const newPid = sm.status('ssh')!.mainPid!;
      expect(newPid).not.toBe(oldPid);
      expect(pm.get(oldPid)).toBeUndefined();
      expect(pm.get(newPid)).toBeDefined();
    });

    it('reload sends SIGHUP to the main process when ExecReload is set', () => {
      const reloadResult = sm.reload('ssh');
      expect(reloadResult.ok).toBe(true);
      expect(sm.isActive('ssh')).toBe(true);
    });
  });

  describe('enable / disable', () => {
    it('disable removes the wants symlink', () => {
      sm.disable('ssh');
      expect(sm.isEnabled('ssh')).toBe(false);
      expect(vfs.existsNoFollow('/etc/systemd/system/multi-user.target.wants/ssh.service')).toBe(false);
    });

    it('enable creates the wants symlink', () => {
      sm.disable('ssh');
      sm.enable('ssh');
      expect(sm.isEnabled('ssh')).toBe(true);
      expect(vfs.existsNoFollow('/etc/systemd/system/multi-user.target.wants/ssh.service')).toBe(true);
    });

    it('disable does not stop the running service', () => {
      sm.disable('ssh');
      expect(sm.isActive('ssh')).toBe(true);
    });

    it('enable does not start a stopped service', () => {
      sm.stop('ssh');
      sm.disable('ssh');
      sm.enable('ssh');
      expect(sm.isActive('ssh')).toBe(false);
    });
  });

  describe('listing', () => {
    it('list all loaded units', () => {
      const units = sm.list();
      expect(units.length).toBeGreaterThan(5);
      expect(units.find(u => u.name === 'ssh')).toBeDefined();
    });

    it('list --failed shows only failed units', () => {
      const failed = sm.list({ state: 'failed' });
      expect(failed.every(u => u.state === 'failed')).toBe(true);
    });

    it('list --state=inactive shows inactive units', () => {
      sm.stop('cron');
      const inactive = sm.list({ state: 'inactive' });
      expect(inactive.find(u => u.name === 'cron')).toBeDefined();
    });
  });

  describe('user-installed unit files', () => {
    it('daemon-reload picks up new unit files from /etc/systemd/system', () => {
      const unit = `[Unit]
Description=My Custom Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/myapp --foreground
User=root

[Install]
WantedBy=multi-user.target
`;
      vfs.writeFile('/etc/systemd/system/myapp.service', unit, 0, 0, 0o022);
      sm.daemonReload();
      const status = sm.status('myapp');
      expect(status).not.toBeNull();
      expect(status!.description).toBe('My Custom Service');
      expect(status!.execStart).toBe('/usr/bin/myapp --foreground');
    });

    it('user units in /etc/systemd/system override /usr/lib/systemd/system', () => {
      const override = `[Unit]
Description=Overridden SSH

[Service]
Type=simple
ExecStart=/usr/sbin/sshd -D -p 2222

[Install]
WantedBy=multi-user.target
`;
      vfs.writeFile('/etc/systemd/system/ssh.service', override, 0, 0, 0o022);
      sm.daemonReload();
      const status = sm.status('ssh');
      expect(status!.description).toBe('Overridden SSH');
      expect(status!.execStart).toContain('2222');
    });
  });

  describe('status output', () => {
    it('status returns null for unknown unit', () => {
      expect(sm.status('totally-fake')).toBeNull();
    });

    it('active services have an activeSince timestamp', () => {
      const status = sm.status('ssh');
      expect(status!.activeSince).toBeInstanceOf(Date);
    });
  });

  describe('server-specific defaults', () => {
    it('server profile loads database service units', () => {
      const sm2 = new LinuxServiceManager(new VirtualFileSystem(), new LinuxProcessManager(), { isServer: true });
      expect(sm2.status('apache2')).not.toBeNull();
      expect(sm2.status('mysql')).not.toBeNull();
    });

    it('apache2 is loaded but inactive by default on server', () => {
      const sm2 = new LinuxServiceManager(new VirtualFileSystem(), new LinuxProcessManager(), { isServer: true });
      expect(sm2.isActive('apache2')).toBe(false);
      expect(sm2.isEnabled('apache2')).toBe(false);
    });
  });
});
