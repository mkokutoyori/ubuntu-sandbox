/**
 * Unit tests — process & service domain events on the EventBus.
 *
 * Validates the reactive taxonomy added in events.ts: the process
 * table and the service layer publish deviceId-scoped events that a
 * supervisor / live UI / telemetry can consume without the managers
 * knowing those consumers exist.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import type { DomainEvent } from '@/events/types';

function collect(bus: EventBus, topic: string): DomainEvent[] {
  const seen: DomainEvent[] = [];
  bus.subscribe(topic as DomainEvent['topic'], (e) => seen.push(e));
  return seen;
}

describe('LinuxProcessManager — domain events', () => {
  let bus: EventBus;
  let pm: LinuxProcessManager;

  beforeEach(() => {
    bus = new EventBus();
    pm = new LinuxProcessManager();
    pm.attachBus(bus, 'dev-1');
  });

  it('spawn publishes linux.process.spawned with identity', () => {
    const seen = collect(bus, 'linux.process.spawned');
    pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ deviceId: 'dev-1', comm: 'sleep', user: 'root' });
  });

  it('a terminating signal publishes signalled then exited', () => {
    const sig = collect(bus, 'linux.process.signalled');
    const exit = collect(bus, 'linux.process.exited');
    const p = pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0 });
    pm.kill(p.pid, 'SIGTERM');
    expect(sig[0].payload).toMatchObject({ pid: p.pid, signal: 'SIGTERM', delivered: true });
    expect(exit[0].payload).toMatchObject({ pid: p.pid, signal: 'SIGTERM', reparented: 0 });
  });

  it('signalling a missing pid reports delivered:false and no exit', () => {
    const sig = collect(bus, 'linux.process.signalled');
    const exit = collect(bus, 'linux.process.exited');
    pm.kill(999999, 'SIGKILL');
    expect(sig[0].payload).toMatchObject({ pid: 999999, delivered: false });
    expect(exit).toHaveLength(0);
  });

  it('SIGSTOP/SIGCONT publish state-changed transitions', () => {
    const seen = collect(bus, 'linux.process.state-changed');
    const p = pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0 });
    pm.kill(p.pid, 'SIGSTOP');
    pm.kill(p.pid, 'SIGCONT');
    expect(seen.map(e => (e.payload as { to: string }).to)).toEqual(['T', 'S']);
  });

  it('renice publishes priority-changed', () => {
    const seen = collect(bus, 'linux.process.priority-changed');
    const p = pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0 });
    pm.renice(p.pid, 10);
    expect(seen[0].payload).toMatchObject({ pid: p.pid, oldNice: 0, newNice: 10 });
  });

  it('no events are published before a bus is attached', () => {
    const lone = new LinuxProcessManager();
    // No throw, no consumer: spawning is a silent no-op event-wise.
    expect(() => lone.spawn({ command: 'x', comm: 'x', user: 'root', uid: 0, gid: 0 }))
      .not.toThrow();
  });
});

describe('LinuxServiceManager — domain events via executor', () => {
  let bus: EventBus;
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    bus = new EventBus();
    exec = new LinuxCommandExecutor(true); // server: root shell, systemctl works
    exec.attachEventBus(bus, 'srv-1');
  });

  it('systemctl stop publishes service stopped + state-changed + process exit', () => {
    const stopped = collect(bus, 'linux.service.stopped');
    const stateCh = collect(bus, 'linux.service.state-changed');
    const procExit = collect(bus, 'linux.process.exited');
    exec.execute('systemctl stop ssh');
    expect(stopped[0].payload).toMatchObject({ deviceId: 'srv-1', name: 'ssh' });
    expect(stateCh.some(e => (e.payload as { to: string }).to === 'inactive')).toBe(true);
    expect(procExit.length).toBeGreaterThan(0);
  });

  it('systemctl start publishes service started + process spawned', () => {
    exec.execute('systemctl stop ssh');
    const started = collect(bus, 'linux.service.started');
    const spawned = collect(bus, 'linux.process.spawned');
    exec.execute('systemctl start ssh');
    expect(started[0].payload).toMatchObject({ name: 'ssh', state: 'active' });
    expect(spawned.some(e => (e.payload as { comm: string }).comm === 'sshd')).toBe(true);
  });

  it('systemctl restart publishes a restarted event', () => {
    const restarted = collect(bus, 'linux.service.restarted');
    exec.execute('systemctl restart cron');
    expect(restarted[0].payload).toMatchObject({ name: 'cron' });
  });

  it('enable / disable publish enablement events', () => {
    exec.execute('systemctl enable cron');
    const disabled = collect(bus, 'linux.service.disabled');
    const enabled = collect(bus, 'linux.service.enabled');
    exec.execute('systemctl disable cron');
    exec.execute('systemctl enable cron');
    expect(disabled[0].payload).toMatchObject({ name: 'cron', enabled: 'disabled' });
    expect(enabled[0].payload).toMatchObject({ name: 'cron', enabled: 'enabled' });
  });
});
