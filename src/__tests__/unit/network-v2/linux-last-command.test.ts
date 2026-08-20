import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Linux last command', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
  });

  describe('default behaviour', () => {
    it('shows at least one session row', async () => {
      const out = await pc.executeCommand('last');
      const lines = out.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });

    it('appends a trailing line that names the wtmp file', async () => {
      const out = await pc.executeCommand('last');
      const lines = out.split('\n');
      expect(lines.some((l) => /^wtmp begins/.test(l))).toBe(true);
    });

    it('shows a session row that names a user and a tty', async () => {
      const out = await pc.executeCommand('last');
      expect(out).toMatch(/\b(user|root)\s+(tty1|pts\/\d+)/);
    });
  });

  describe('-n / --limit', () => {
    it('caps the number of session rows shown', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      for (const u of ['alice', 'bob', 'carol', 'dave']) {
        srv.recordSshLogin(u, '10.0.0.1', 'PC1', true, 'password');
      }
      const out = await srv.executeCommand('last -n 2');
      const rows = out.split('\n').filter((l) => !!l && !l.startsWith('wtmp begins'));
      expect(rows.length).toBeLessThanOrEqual(2);
    });

    it('--limit is equivalent to -n', async () => {
      const a = await pc.executeCommand('last -n 3');
      const b = await pc.executeCommand('last --limit 3');
      expect(b).toBe(a);
    });
  });

  describe('user filter', () => {
    it('"last <user>" restricts to that user', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      srv.recordSshLogin('alice', '10.0.0.1', 'PC1', true, 'password');
      srv.recordSshLogin('bob', '10.0.0.1', 'PC1', true, 'password');
      const out = await srv.executeCommand('last alice');
      const rows = out.split('\n').filter((l) => !!l && !l.startsWith('wtmp begins'));
      expect(rows.every((r) => /^alice\b/.test(r))).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('unknown user yields no session rows but keeps the wtmp footer', async () => {
      const out = await pc.executeCommand('last nonexistent');
      expect(out).toMatch(/^wtmp begins/m);
      const rows = out.split('\n').filter((l) => !!l && !l.startsWith('wtmp begins'));
      expect(rows.length).toBe(0);
    });
  });

  describe('-i / --ip', () => {
    it('-i shows IP addresses in the FROM column', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      srv.recordSshLogin('alice', '10.0.0.1', 'PC1', true, 'password');
      const out = await srv.executeCommand('last -i alice');
      expect(out).toMatch(/\b10\.0\.0\.1\b/);
    });
  });

  describe('reboot pseudo-user', () => {
    it('"last reboot" prints at least one reboot row', async () => {
      const out = await pc.executeCommand('last reboot');
      expect(out).toMatch(/^reboot\b/m);
    });
  });

  describe('--help', () => {
    it('prints the util-linux usage block', async () => {
      const out = await pc.executeCommand('last --help');
      expect(out).toMatch(/^Usage:\s+last\b/m);
      expect(out).toMatch(/-n, --limit/);
      expect(out).toMatch(/-F, --fulltimes/);
      expect(out).toMatch(/-i, --ip/);
    });
  });

  describe('--version', () => {
    it('prints the util-linux version line', async () => {
      const out = await pc.executeCommand('last --version');
      expect(out).toMatch(/^last from util-linux/);
    });
  });

  describe('unknown flag', () => {
    it('rejects unknown short flags with the util-linux diagnostic', async () => {
      const out = await pc.executeCommand('last -Z');
      expect(out).toMatch(/^last: invalid option/);
    });
  });
});
