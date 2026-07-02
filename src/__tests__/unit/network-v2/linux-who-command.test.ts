import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Linux who command', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
  });

  describe('default behaviour', () => {
    it('shows one line per active session: name tty login-time host', async () => {
      const out = await pc.executeCommand('who');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^user\s+tty1\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+\(:0\)/);
    });

    it('shows each SSH-logged user with their pts/N line', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      srv.recordSshLogin('alice', '10.0.0.1', 'PC1', true, 'password');
      const out = await srv.executeCommand('who');
      const lines = out.split('\n').filter(Boolean);
      expect(lines.some((l) => /^alice\s+pts\//.test(l))).toBe(true);
      expect(lines.some((l) => /\(10\.0\.0\.1\)/.test(l))).toBe(true);
    });
  });

  describe('-H / --heading', () => {
    it('prepends the NAME LINE TIME COMMENT header', async () => {
      const out = await pc.executeCommand('who -H');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[0]).toMatch(/^NAME\s+LINE\s+TIME\s+COMMENT/);
      expect(lines.length).toBe(2);
    });

    it('--heading is the long-form alias', async () => {
      const out = await pc.executeCommand('who --heading');
      expect(out.split('\n')[0]).toMatch(/^NAME\s+LINE\s+TIME/);
    });
  });

  describe('-q / --count', () => {
    it('prints user list then "# users=N"', async () => {
      const out = await pc.executeCommand('who -q');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[0]).toMatch(/^user\b/);
      expect(lines[1]).toMatch(/^# users=1$/);
    });
  });

  describe('-b / --boot', () => {
    it('prints a single "system boot" line', async () => {
      const out = await pc.executeCommand('who -b');
      expect(out.trim()).toMatch(/^system boot\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  describe('-r / --runlevel', () => {
    it('prints "run-level 5" with the boot time', async () => {
      const out = await pc.executeCommand('who -r');
      expect(out.trim()).toMatch(/^\s*run-level 5\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  describe('-u / --users', () => {
    it('adds an IDLE column and a PID column', async () => {
      const out = await pc.executeCommand('who -u');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[0]).toMatch(/^user\s+tty1\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+\S+\s+\d+\s+\(:0\)/);
    });
  });

  describe('-T / --mesg', () => {
    it('adds a +/-/? status marker between name and tty', async () => {
      const out = await pc.executeCommand('who -T');
      expect(out).toMatch(/^user\s+[+\-?]\s+tty1\b/);
    });
  });

  describe('-m and "who am i"', () => {
    it('-m shows only the current session', async () => {
      const out = await pc.executeCommand('who -m');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^user\s+tty1\b/);
    });

    it('"who am i" behaves like -m', async () => {
      const out = await pc.executeCommand('who am i');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^user\s+tty1\b/);
    });

    it('-m and "am i" filter out other sessions', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      srv.recordSshLogin('alice', '10.0.0.1', 'PC1', true, 'password');
      srv.recordSshLogin('bob', '10.0.0.1', 'PC1', true, 'password');
      const out = await srv.executeCommand('who am i');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
    });
  });

  describe('-a / --all combines several flags', () => {
    it('includes the system-boot, run-level, idle and PID', async () => {
      const out = await pc.executeCommand('who -a');
      expect(out).toMatch(/system boot/);
      expect(out).toMatch(/run-level 5/);
      expect(out).toMatch(/user\s+\S+\s+tty1/);
    });
  });

  describe('--help', () => {
    it('prints the usage block and lists flags', async () => {
      const out = await pc.executeCommand('who --help');
      expect(out).toMatch(/^Usage: who/m);
      expect(out).toMatch(/-a, --all/);
      expect(out).toMatch(/-H, --heading/);
      expect(out).toMatch(/-q, --count/);
      expect(out).toMatch(/-u, --users/);
    });
  });

  describe('--version', () => {
    it('prints the version line', async () => {
      const out = await pc.executeCommand('who --version');
      expect(out).toMatch(/^who \(GNU coreutils\)/);
    });
  });

  describe('-s short format equals default', () => {
    it('-s output equals plain who output', async () => {
      const a = await pc.executeCommand('who');
      const b = await pc.executeCommand('who -s');
      expect(b).toBe(a);
    });
  });

  describe('unknown flag', () => {
    it('rejects unknown short flags with the coreutils error', async () => {
      const out = await pc.executeCommand('who -Z');
      expect(out).toMatch(/who: invalid option -- 'Z'/);
      expect(out).toMatch(/Try 'who --help'/);
    });
  });
});
