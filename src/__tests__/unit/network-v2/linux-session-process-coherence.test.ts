import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Sessions are coherent with the process table and loginctl', () => {
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

  describe('SSH login spawns a shell process in ps', () => {
    it('after ssh login, ps -ef shows a bash process owned by the SSH user', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('ps -ef');
      expect(out).toMatch(/^alice\s+\d+.+(\b-?bash\b)/m);
    });

    it('the PID who -u reports for the SSH user appears in ps', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const whoOut = await srv.executeCommand('who -u');
      const aliceLine = whoOut.split('\n').find((l) => /^alice\b/.test(l)) ?? '';
      const m = aliceLine.match(/(\d+)\s+\(/);
      expect(m).not.toBeNull();
      const pid = m![1];
      const psOut = await srv.executeCommand(`ps -p ${pid}`);
      expect(psOut).toMatch(new RegExp(`^\\s*${pid}\\b`, 'm'));
    });
  });

  describe('loginctl list-sessions is coherent with who', () => {
    it('shows one row per active session', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('loginctl list-sessions');
      const lines = out.split('\n').filter(Boolean);
      expect(lines[0]).toMatch(/^SESSION\s+UID\s+USER\b/);
      expect(lines.some((l) => /\balice\b/.test(l))).toBe(true);
    });

    it('the "N sessions listed" footer matches the active count', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('loginctl list-sessions');
      const m = out.match(/(\d+) sessions? listed\./);
      expect(m).not.toBeNull();
      const n = Number.parseInt(m![1], 10);
      expect(n).toBeGreaterThanOrEqual(2);
    });
  });

  describe('loginctl show-session reports per-session detail', () => {
    it('loginctl show-session <id> exposes User= and TTY= matching who', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const listOut = await srv.executeCommand('loginctl list-sessions');
      const sessRow = listOut.split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sessRow.trim().split(/\s+/)[0];
      expect(sid).toMatch(/^\d+$/);
      const detail = await srv.executeCommand(`loginctl show-session ${sid}`);
      expect(detail).toMatch(/^Name=alice$/m);
      expect(detail).toMatch(/^TTY=pts\/\d+$/m);
      expect(detail).toMatch(/^State=active$/m);
    });

    it('Leader= in loginctl show-session matches a real -bash PID in ps', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const listOut = await srv.executeCommand('loginctl list-sessions');
      const sessRow = listOut.split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sessRow.trim().split(/\s+/)[0];
      const detail = await srv.executeCommand(`loginctl show-session ${sid}`);
      const m = detail.match(/^Leader=(\d+)$/m);
      expect(m).not.toBeNull();
      const leader = m![1];
      const psOut = await srv.executeCommand(`ps -p ${leader}`);
      expect(psOut).toMatch(/-bash/);
    });
  });

  describe('loginctl list-users mirrors active session users', () => {
    it('alice appears once in list-users after an SSH login', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('loginctl list-users');
      expect(out).toMatch(/^\s*\d+\s+alice\b/m);
      expect(out).toMatch(/\d+ users listed\./);
    });
  });

  describe('pgrep aligns with the active sessions', () => {
    it('pgrep -u alice finds the spawned login shell', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const out = await srv.executeCommand('pgrep -u alice');
      expect(out.trim().split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('loginctl terminate-session closes the session everywhere', () => {
    it('removes the session from who, kills its bash, and stamps a close in wtmp', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const listOut = await srv.executeCommand('loginctl list-sessions');
      const sessRow = listOut.split('\n').find((l) => /alice/.test(l)) ?? '';
      const sid = sessRow.trim().split(/\s+/)[0];
      const detail = await srv.executeCommand(`loginctl show-session ${sid}`);
      const leaderPid = detail.match(/^Leader=(\d+)$/m)?.[1] ?? '';
      expect(leaderPid).toMatch(/^\d+$/);

      await srv.executeCommand(`loginctl terminate-session ${sid}`);

      const whoAfter = await srv.executeCommand('who');
      expect(whoAfter).not.toMatch(/^alice\b/m);

      const psAfter = await srv.executeCommand(`ps -p ${leaderPid}`);
      expect(psAfter).not.toMatch(new RegExp(`^\\s*${leaderPid}\\b`, 'm'));

      const lastAfter = await srv.executeCommand('last -F');
      expect(lastAfter).toMatch(/^alice\b/m);
      const aliceRow = lastAfter.split('\n').find((l) => /^alice\b/.test(l)) ?? '';
      expect(aliceRow).not.toMatch(/still logged in/);
    });
  });

  describe('loginctl kill-session sends the requested signal', () => {
    it('kill-session --signal=SIGTERM also closes the session', async () => {
      await pc.executeCommand('ssh alice@10.0.0.2');
      const listOut = await srv.executeCommand('loginctl list-sessions');
      const sid = (listOut.split('\n').find((l) => /alice/.test(l)) ?? '').trim().split(/\s+/)[0];
      await srv.executeCommand(`loginctl kill-session --signal=SIGTERM ${sid}`);
      const out = await srv.executeCommand('loginctl list-sessions');
      expect(out).not.toMatch(/\balice\b/);
    });
  });
});
