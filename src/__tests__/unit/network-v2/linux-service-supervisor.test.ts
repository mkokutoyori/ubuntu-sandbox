/**
 * Unit tests — LinuxServiceSupervisor (reactive consumer).
 *
 * The supervisor subscribes to `linux.process.exited` and applies the
 * unit Restart= policy: it must auto-restart a crashed daemon, mark a
 * Restart=no daemon failed, and never fight an intentional
 * `systemctl stop` (no restart loop).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

function writeUnit(exec: LinuxCommandExecutor, name: string, restart: string): void {
  const unit = [
    '[Unit]', `Description=${name} test daemon`, '',
    '[Service]', 'Type=simple', `ExecStart=/usr/bin/${name} -D`,
    `Restart=${restart}`, '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\\n');
  exec.execute(`printf "${unit}" > /etc/systemd/system/${name}.service`);
  exec.execute('systemctl daemon-reload');
}

describe('LinuxServiceSupervisor', () => {
  let bus: EventBus;
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    bus = new EventBus();
    exec = new LinuxCommandExecutor(true); // server / root
    exec.attachEventBus(bus, 'sup-1');
  });

  it('auto-restarts a Restart=always daemon when its main process is killed', () => {
    writeUnit(exec, 'alpha', 'always');
    exec.execute('systemctl start alpha');
    const u1 = exec.serviceMgr.status('alpha');
    expect(u1?.state).toBe('active');
    const oldPid = u1!.mainPid!;

    // Simulate a crash: something external kills the main process.
    exec.processMgr.kill(oldPid, 'SIGKILL');

    const u2 = exec.serviceMgr.status('alpha');
    expect(u2?.state).toBe('active');
    expect(u2?.mainPid).toBeDefined();
    expect(u2!.mainPid).not.toBe(oldPid);
  });

  it('marks a Restart=no daemon as failed when it dies', () => {
    const failed: string[] = [];
    bus.subscribe('linux.service.failed', e => failed.push(e.payload.name));
    writeUnit(exec, 'beta', 'no');
    exec.execute('systemctl start beta');
    const pid = exec.serviceMgr.status('beta')!.mainPid!;

    exec.processMgr.kill(pid, 'SIGKILL');

    expect(exec.serviceMgr.status('beta')?.state).toBe('failed');
    expect(failed).toContain('beta');
  });

  it('does NOT restart on an intentional systemctl stop', () => {
    writeUnit(exec, 'gamma', 'always');
    exec.execute('systemctl start gamma');
    expect(exec.serviceMgr.status('gamma')?.state).toBe('active');

    exec.execute('systemctl stop gamma');

    const u = exec.serviceMgr.status('gamma');
    expect(u?.state).toBe('inactive');
    expect(u?.mainPid).toBeUndefined();
  });

  it('ignores exits of non-service processes', () => {
    const p = exec.processMgr.spawn({
      command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0,
    });
    expect(() => exec.processMgr.kill(p.pid, 'SIGKILL')).not.toThrow();
  });

  it('a restarted daemon stays supervised across successive crashes', () => {
    writeUnit(exec, 'delta', 'on-failure');
    exec.execute('systemctl start delta');

    for (let i = 0; i < 3; i++) {
      const pid = exec.serviceMgr.status('delta')!.mainPid!;
      exec.processMgr.kill(pid, 'SIGKILL');
      expect(exec.serviceMgr.status('delta')?.state).toBe('active');
    }
  });
});
