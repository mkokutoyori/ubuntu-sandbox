import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Linux w command', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
  });

  describe('default behaviour', () => {
    it('prints a single uptime header line + column header + one session row', async () => {
      const out = await pc.executeCommand('w');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^\s*\d{2}:\d{2}:\d{2}\s+up\b.+\b1 user(s)?,/);
      expect(lines[1]).toMatch(/^USER\s+TTY\s+FROM\s+LOGIN@\s+IDLE\s+JCPU\s+PCPU\s+WHAT/);
      expect(lines[2]).toMatch(/^user\s+tty1\s+:0\s+\d{2}:\d{2}\b/);
    });

    it('header time is HH:MM:SS, not truncated', async () => {
      const out = await pc.executeCommand('w');
      const first = out.split('\n')[0];
      expect(first).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('uses singular "user" when exactly one is logged in', async () => {
      const out = await pc.executeCommand('w');
      expect(out.split('\n')[0]).toMatch(/\b1 user,/);
      expect(out.split('\n')[0]).not.toMatch(/\b1 users,/);
    });
  });

  describe('-h / --no-header', () => {
    it('-h suppresses both the uptime header and the column header', async () => {
      const out = await pc.executeCommand('w -h');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^user\s+tty1\b/);
    });

    it('--no-header is equivalent to -h', async () => {
      const a = await pc.executeCommand('w -h');
      const b = await pc.executeCommand('w --no-header');
      expect(b).toBe(a);
    });
  });

  describe('-s / --short', () => {
    it('drops the LOGIN@, JCPU and PCPU columns from the header and rows', async () => {
      const out = await pc.executeCommand('w -s');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[1]).toMatch(/^USER\s+TTY\s+FROM\s+IDLE\s+WHAT/);
      expect(lines[1]).not.toMatch(/LOGIN@/);
      expect(lines[1]).not.toMatch(/JCPU/);
      expect(lines[1]).not.toMatch(/PCPU/);
    });
  });

  describe('-f / --from toggles the FROM column', () => {
    it('-f turns the FROM column off when on by default', async () => {
      const def = await pc.executeCommand('w');
      const off = await pc.executeCommand('w -f');
      expect(def.split('\n')[1]).toMatch(/FROM/);
      expect(off.split('\n')[1]).not.toMatch(/FROM/);
    });
  });

  describe('filter by user', () => {
    it('w <user> restricts to the given user', async () => {
      const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
      const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
      srv.powerOn(); sw.powerOn();
      new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
      new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
      srv.recordSshLogin('alice', '10.0.0.1', 'PC1', true, 'password');
      srv.recordSshLogin('bob', '10.0.0.1', 'PC1', true, 'password');
      const out = await srv.executeCommand('w alice');
      const dataRows = out.split('\n').filter(Boolean).slice(2);
      expect(dataRows).toHaveLength(1);
      expect(dataRows[0]).toMatch(/^alice\b/);
    });

    it('unknown user produces no data rows but keeps the header', async () => {
      const out = await pc.executeCommand('w nonexistent');
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/\bup\b/);
      expect(lines[1]).toMatch(/^USER/);
    });
  });

  describe('--help', () => {
    it('prints the procps-ng usage block', async () => {
      const out = await pc.executeCommand('w --help');
      expect(out).toMatch(/^Usage:\s+w\b/m);
      expect(out).toMatch(/-h, --no-header/);
      expect(out).toMatch(/-s, --short/);
      expect(out).toMatch(/-f, --from/);
    });
  });

  describe('--version', () => {
    it('prints the procps-ng version line', async () => {
      const out = await pc.executeCommand('w --version');
      expect(out).toMatch(/^w from procps-ng/);
    });
  });

  describe('unknown flag', () => {
    it('produces the procps-ng diagnostic and a non-zero exit code', async () => {
      const out = await pc.executeCommand('w -Z');
      expect(out).toMatch(/^w: invalid option/);
    });
  });
});
