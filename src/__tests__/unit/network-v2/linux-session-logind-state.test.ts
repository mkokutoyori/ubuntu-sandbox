import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('systemd-logind state mirrors active SSH sessions', () => {
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

  async function sidFor(user: string): Promise<string> {
    const out = await srv.executeCommand('loginctl list-sessions');
    const row = out.split('\n').find((l) => l.includes(user)) ?? '';
    return row.trim().split(/\s+/)[0];
  }

  describe('/run/systemd/sessions/<sid> is written on login', () => {
    it('contains UID, USER, TTY, LEADER, SERVICE=sshd, STATE=active', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const sid = await sidFor('alice');
      const content = await srv.executeCommand(`cat /run/systemd/sessions/${sid}`);
      expect(content).toMatch(/^UID=\d+$/m);
      expect(content).toMatch(/^USER=alice$/m);
      expect(content).toMatch(/^TTY=pts\/\d+$/m);
      expect(content).toMatch(/^LEADER=\d+$/m);
      expect(content).toMatch(/^SERVICE=sshd$/m);
      expect(content).toMatch(/^STATE=active$/m);
      expect(content).toMatch(/^REMOTE=1$/m);
      expect(content).toMatch(/^REMOTE_HOST=10\.0\.0\.1$/m);
    });
  });

  describe('/run/systemd/users/<uid> is written on login', () => {
    it('contains NAME, STATE=active, SESSIONS, SLICE, RUNTIME', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const sid = await sidFor('alice');
      const uidLine = (await srv.executeCommand('loginctl list-sessions'))
        .split('\n').find((l) => l.includes('alice')) ?? '';
      const uid = uidLine.trim().split(/\s+/)[1];
      const content = await srv.executeCommand(`cat /run/systemd/users/${uid}`);
      expect(content).toMatch(/^NAME=alice$/m);
      expect(content).toMatch(/^STATE=active$/m);
      expect(content).toMatch(new RegExp(`^SESSIONS=.*\\b${sid}\\b`, 'm'));
      expect(content).toMatch(new RegExp(`^SLICE=user-${uid}\\.slice$`, 'm'));
      expect(content).toMatch(new RegExp(`^RUNTIME=/run/user/${uid}$`, 'm'));
    });
  });

  describe('/run/user/<uid> runtime dir is provisioned', () => {
    it('exists as a directory after SSH login', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const uidLine = (await srv.executeCommand('loginctl list-sessions'))
        .split('\n').find((l) => l.includes('alice')) ?? '';
      const uid = uidLine.trim().split(/\s+/)[1];
      const out = await srv.executeCommand(`ls -ld /run/user/${uid}`);
      expect(out).toMatch(/^d/);
      expect(out).toMatch(new RegExp(`/run/user/${uid}`));
    });
  });

  describe('logind state is cleaned up on session close', () => {
    it('/run/systemd/sessions/<sid> goes away after terminate-session', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const sid = await sidFor('alice');
      const before = await srv.executeCommand(`cat /run/systemd/sessions/${sid}`);
      expect(before).toMatch(/^USER=alice$/m);
      await srv.executeCommand(`loginctl terminate-session ${sid}`);
      const after = await srv.executeCommand(`cat /run/systemd/sessions/${sid}`);
      expect(after).toMatch(/No such file/);
    });
  });
});
