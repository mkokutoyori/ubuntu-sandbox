import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('who / w / last are coherent with /var/run/utmp and /var/log/wtmp', () => {
  let pc: LinuxPC;
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');
    await srv.executeCommand('ifconfig eth0 10.0.0.2');
  });

  describe('utmp / wtmp / btmp files exist on disk', () => {
    it('/var/run/utmp exists as a regular file', async () => {
      const out = await srv.executeCommand('ls -l /var/run/utmp');
      expect(out).toMatch(/\/var\/run\/utmp/);
      expect(out).not.toMatch(/No such file/);
    });

    it('/var/log/wtmp exists as a regular file', async () => {
      const out = await srv.executeCommand('ls -l /var/log/wtmp');
      expect(out).toMatch(/\/var\/log\/wtmp/);
      expect(out).not.toMatch(/No such file/);
    });

    it('/var/log/btmp exists as a regular file', async () => {
      const out = await srv.executeCommand('ls -l /var/log/btmp');
      expect(out).toMatch(/\/var\/log\/btmp/);
      expect(out).not.toMatch(/No such file/);
    });
  });

  describe('login appears in wtmp', () => {
    it('a successful SSH login appears in last on the server', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('last -n 5');
      expect(out).toMatch(/^alice\b/m);
    });
  });

  describe('truncating wtmp clears last output', () => {
    it('echo > /var/log/wtmp removes prior login rows from last', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const before = await srv.executeCommand('last -n 10');
      expect(before).toMatch(/^alice\b/m);
      await srv.executeCommand('echo -n > /var/log/wtmp');
      const after = await srv.executeCommand('last -n 10');
      expect(after).not.toMatch(/^alice\b/m);
    });
  });

  describe('truncating utmp clears who/w output', () => {
    it('echo > /var/run/utmp empties the who session list', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const before = await srv.executeCommand('who');
      expect(before).toMatch(/^alice\b/m);
      await srv.executeCommand('echo -n > /var/run/utmp');
      const after = await srv.executeCommand('who');
      expect(after).not.toMatch(/^alice\b/m);
    });
  });

  describe('lastb reads from /var/log/btmp', () => {
    it('clearing /var/log/btmp empties lastb', async () => {
      await srv.executeCommand('echo -n > /var/log/btmp');
      const out = await srv.executeCommand('lastb');
      const rows = out.split('\n').filter((l) => !!l && !/^btmp begins/.test(l));
      expect(rows).toHaveLength(0);
    });
  });

  describe('lastb footer is well-formed', () => {
    it('the footer ends with a four-digit year and HH:MM:SS', async () => {
      const out = await srv.executeCommand('lastb');
      const footer = out.split('\n').find((l) => /^btmp begins/.test(l)) ?? '';
      expect(footer).toMatch(/btmp begins\s+\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/);
    });
  });
});
