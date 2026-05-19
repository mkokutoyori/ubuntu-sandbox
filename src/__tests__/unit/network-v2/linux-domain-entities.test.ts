/**
 * Unit tests — LinuxProcess / LinuxService domain entities.
 *
 * The reactive refonte replaces anonymous process/service records with
 * real objects that own their invariants. These must remain
 * structurally compatible with the ProcessInfo / ServiceUnit
 * interfaces so every existing consumer keeps working.
 */

import { describe, it, expect } from 'vitest';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxProcess } from '@/network/devices/linux/process/LinuxProcess';
import { LinuxService } from '@/network/devices/linux/service/LinuxService';
import type { ServiceUnit } from '@/network/devices/linux/LinuxServiceManager';

describe('LinuxProcess entity', () => {
  it('the process table stores LinuxProcess instances', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0 });
    expect(p).toBeInstanceOf(LinuxProcess);
    expect(pm.get(1)).toBeInstanceOf(LinuxProcess);
  });

  it('behaviour methods answer correctly', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({
      command: '/usr/sbin/sshd -D', comm: 'sshd', user: 'root', uid: 0, gid: 0,
      serviceName: 'ssh',
    }) as LinuxProcess;
    expect(p.is('S')).toBe(true);
    expect(p.ownedBy('root')).toBe(true);
    expect(p.isServiceProcess()).toBe(true);
    expect(p.matchesComm('sshd')).toBe(true);
  });

  it('matchesComm strips the login-shell dash', () => {
    const proc = new LinuxProcess({
      pid: 9, ppid: 1, pgid: 9, sid: 9, uid: 0, gid: 0, user: 'root',
      command: '-bash', comm: '-bash', args: [], state: 'S',
      startTime: new Date(), cpuTime: 0, vsize: 1, rss: 1, tty: 'pts/0',
      nice: 0, priority: 20, cwd: '/', exe: '-bash',
    });
    expect(proc.matchesComm('bash')).toBe(true);
  });

  it('applyNice keeps priority consistent', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({ command: 'x', comm: 'x', user: 'root', uid: 0, gid: 0 }) as LinuxProcess;
    p.applyNice(10);
    expect(p.nice).toBe(10);
    expect(p.priority).toBe(30);
  });

  it('prototype methods are invisible to structural equality', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({ command: 'x', comm: 'x', user: 'root', uid: 0, gid: 0 });
    const snap = (p as LinuxProcess).snapshot();
    expect(snap).toEqual({ ...p });
    expect(Object.keys(snap)).not.toContain('matchesComm');
  });
});

describe('LinuxService entity', () => {
  const base: ServiceUnit = {
    name: 'demo', description: 'demo', type: 'simple', execStart: '/bin/true',
    user: 'root', group: 'root', wantedBy: [], after: [], requires: [],
    restart: 'on-failure', loadedFrom: '/etc/systemd/system/demo.service',
    state: 'active', enabled: 'enabled',
  };

  it('answers active / enabled / masked', () => {
    const s = new LinuxService(base);
    expect(s.isActive()).toBe(true);
    expect(s.isEnabled()).toBe(true);
    expect(s.isMasked()).toBe(false);
  });

  it('wantsAutoRestart reflects the Restart= policy', () => {
    expect(new LinuxService({ ...base, restart: 'always' }).wantsAutoRestart()).toBe(true);
    expect(new LinuxService({ ...base, restart: 'on-failure' }).wantsAutoRestart()).toBe(true);
    expect(new LinuxService({ ...base, restart: 'no' }).wantsAutoRestart()).toBe(false);
  });

  it('snapshot is a plain structural copy', () => {
    const s = new LinuxService(base);
    expect(s.snapshot()).toEqual({ ...base });
  });
});
