import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('/proc/<pid>/{loginuid,sessionid,cgroup} bind processes to sessions', () => {
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

  async function alicePid(): Promise<string> {
    const ps = await srv.executeCommand('ps -ef');
    return ps.split('\n').find((l) => l.startsWith('alice'))?.split(/\s+/)[1] ?? '0';
  }

  describe('login-shell process', () => {
    it('cat /proc/<pid>/loginuid matches alice uid', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const pid = await alicePid();
      const out = (await srv.executeCommand(`cat /proc/${pid}/loginuid`)).trim();
      expect(out).toBe('1000');
    });

    it('cat /proc/<pid>/sessionid matches the loginctl session id', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const pid = await alicePid();
      const sessionid = (await srv.executeCommand(`cat /proc/${pid}/sessionid`)).trim();
      const sidRow = (await srv.executeCommand('loginctl list-sessions'))
        .split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sidRow.trim().split(/\s+/)[0];
      expect(sessionid).toBe(sid);
    });

    it('cat /proc/<pid>/cgroup names the per-session scope and user slice', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const pid = await alicePid();
      const out = await srv.executeCommand(`cat /proc/${pid}/cgroup`);
      expect(out).toMatch(/0::\/user\.slice\/user-1000\.slice\/session-\d+\.scope/);
    });
  });

  describe('a daemon process has unset loginuid/sessionid', () => {
    it('init (pid 1) reports 4294967295 / -1 for unset audit IDs', async () => {
      const loginuid = (await srv.executeCommand('cat /proc/1/loginuid')).trim();
      const sessionid = (await srv.executeCommand('cat /proc/1/sessionid')).trim();
      expect(loginuid).toBe('4294967295');
      expect(sessionid).toMatch(/^(4294967295|-1)$/);
    });

    it('sshd master process belongs to /system.slice/ssh.service', async () => {
      const ps = await srv.executeCommand('ps -ef');
      const masterRow = ps.split('\n').find((l) => /\/usr\/sbin\/sshd -D/.test(l)) ?? '';
      const masterPid = masterRow.split(/\s+/)[1];
      const cg = await srv.executeCommand(`cat /proc/${masterPid}/cgroup`);
      expect(cg).toMatch(/0::\/system\.slice\/ssh\.service/);
    });
  });
});
