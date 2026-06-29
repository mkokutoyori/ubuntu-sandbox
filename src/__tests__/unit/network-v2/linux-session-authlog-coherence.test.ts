import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('auth.log mirrors PAM + systemd-logind session lifecycle', () => {
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

  describe('login emits the PAM session-opened line', () => {
    it('auth.log contains pam_unix(sshd:session): session opened for user alice', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const log = await srv.executeCommand('cat /var/log/auth.log');
      expect(log).toMatch(/pam_unix\(sshd:session\): session opened for user alice/);
    });
  });

  describe('login emits the systemd-logind New session line', () => {
    it('auth.log contains systemd-logind[...] New session N of user alice.', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const log = await srv.executeCommand('cat /var/log/auth.log');
      expect(log).toMatch(/systemd-logind\[\d+\]: New session \d+ of user alice\./);
    });
  });

  describe('terminate-session emits PAM session-closed + logind Removed-session lines', () => {
    it('auth.log gains session closed for user alice', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const sidRow = (await srv.executeCommand('loginctl list-sessions'))
        .split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sidRow.trim().split(/\s+/)[0];
      await srv.executeCommand(`loginctl terminate-session ${sid}`);
      const log = await srv.executeCommand('cat /var/log/auth.log');
      expect(log).toMatch(/pam_unix\(sshd:session\): session closed for user alice/);
    });

    it('the journal does NOT include a duplicate -bash[<pid>]: ... spawn line', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const log = await srv.executeCommand('journalctl');
      expect(log).not.toMatch(/-bash\[\d+\]:\s+\[\d+\]\s+alice:/);
    });

    it('auth.log gains systemd-logind Removed session N.', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const sidRow = (await srv.executeCommand('loginctl list-sessions'))
        .split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sidRow.trim().split(/\s+/)[0];
      await srv.executeCommand(`loginctl terminate-session ${sid}`);
      const log = await srv.executeCommand('cat /var/log/auth.log');
      expect(log).toMatch(new RegExp(`systemd-logind\\[\\d+\\]: Removed session ${sid}\\.`));
    });
  });
});
