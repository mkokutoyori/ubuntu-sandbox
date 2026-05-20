/**
 * Unit tests — OS-agnostic core domain classes.
 *
 * These classes are the cross-platform spine: `OSProcess`, `OSService`,
 * `OSFeatureGate`, `OSServiceOrchestrator`. Linux/Windows/Mac process
 * & service models extend them. Tests here exercise only the shared
 * surface (rich attributes, snapshot, feature gating, lifecycle
 * orchestration) — OS-specific behavior lives in adapter test files.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OSProcess } from '@/network/devices/os/OSProcess';
import { OSService } from '@/network/devices/os/OSService';
import { OSFeatureGate } from '@/network/devices/os/OSFeatureGate';
import { OSServiceOrchestrator } from '@/network/devices/os/OSServiceOrchestrator';

// ─── OSProcess ────────────────────────────────────────────────────────

describe('OSProcess — rich process record', () => {
  let p: OSProcess;
  beforeEach(() => {
    p = new OSProcess({
      pid: 100, ppid: 1, uid: 0, gid: 0, user: 'root',
      command: '/usr/sbin/sshd -D', comm: 'sshd', args: ['-D'],
      exe: '/usr/sbin/sshd',
    });
  });

  it('defaults its derived fields sensibly', () => {
    expect(p.state).toBe('S');
    expect(p.pgid).toBe(p.pid);
    expect(p.sid).toBe(p.pid);
    expect(p.nice).toBe(0);
    expect(p.priority).toBe(20);
    expect(p.numThreads).toBe(1);
    expect(p.schedPolicy).toBe('SCHED_OTHER');
    expect(p.ioClass).toBe('best-effort');
    expect(p.openFiles).toEqual([]);
    expect(p.cpuAffinity).toEqual([0]);
  });

  it('isAlive is true except for Z (zombie) and X (dead)', () => {
    expect(p.isAlive()).toBe(true);
    p.state = 'Z'; expect(p.isAlive()).toBe(false);
    p.state = 'X'; expect(p.isAlive()).toBe(false);
    p.state = 'R'; expect(p.isAlive()).toBe(true);
  });

  it('matches(comm) is exact match', () => {
    expect(p.matches('sshd')).toBe(true);
    expect(p.matches('ssh')).toBe(false);
  });

  it('ownedBy(uid) returns true for matching uid', () => {
    expect(p.ownedBy(0)).toBe(true);
    expect(p.ownedBy(1000)).toBe(false);
  });

  it('applyNice updates nice and derived priority + clamps to [-20, 19]', () => {
    p.applyNice(10);
    expect(p.nice).toBe(10);
    expect(p.priority).toBe(30);
    p.applyNice(-50);
    expect(p.nice).toBe(-20);
    p.applyNice(99);
    expect(p.nice).toBe(19);
  });

  it('addOpenFile / closeOpenFile maintain the fd table', () => {
    const fd = p.addOpenFile('/var/log/auth.log', 'w');
    expect(fd).toBe(3); // stdin/stdout/stderr taken
    expect(p.openFiles).toHaveLength(1);
    p.closeOpenFile(fd);
    expect(p.openFiles).toHaveLength(0);
  });

  it('snapshot is a plain object copy (no methods)', () => {
    const snap = p.snapshot();
    expect(snap.pid).toBe(100);
    expect((snap as unknown as { isAlive?: unknown }).isAlive).toBeUndefined();
  });
});

// ─── OSService ────────────────────────────────────────────────────────

describe('OSService — rich service unit', () => {
  let s: OSService;
  beforeEach(() => {
    s = new OSService({
      name: 'ssh',
      displayName: 'OpenBSD Secure Shell server',
      description: 'sshd daemon',
      execStart: '/usr/sbin/sshd -D',
      user: 'root',
      group: 'root',
    });
  });

  it('starts in a sane default state', () => {
    expect(s.state).toBe('inactive');
    expect(s.enabled).toBe('enabled');
    expect(s.startType).toBe('automatic');
    expect(s.restart).toBe('on-failure');
    expect(s.failureCount).toBe(0);
    expect(s.configFiles).toEqual([]);
    expect(s.logFiles).toEqual([]);
    expect(s.dependsOn).toEqual([]);
    expect(s.listenPorts).toEqual([]);
  });

  it('isActive / isEnabled / isMasked / canStart reflect state', () => {
    expect(s.isActive()).toBe(false);
    expect(s.canStart()).toBe(true);
    s.state = 'active'; expect(s.isActive()).toBe(true);
    s.enabled = 'masked'; expect(s.isMasked()).toBe(true);
    expect(s.canStart()).toBe(false);
  });

  it('effectiveProp / setProperty work as overrides', () => {
    expect(s.effectiveProp('Id')).toBe('ssh.service');
    s.setProperty('CPUQuota', '50%');
    expect(s.effectiveProp('CPUQuota')).toBe('50%');
  });

  it('recordFailure increments failureCount and stores last error', () => {
    s.recordFailure('exit-code', 1);
    expect(s.failureCount).toBe(1);
    expect(s.lastFailureReason).toBe('exit-code');
    expect(s.state).toBe('failed');
  });
});

// ─── OSFeatureGate ────────────────────────────────────────────────────

describe('OSFeatureGate — service/process gating', () => {
  const sshd = new OSProcess({
    pid: 12, ppid: 1, uid: 0, gid: 0, user: 'root',
    command: '/usr/sbin/sshd -D', comm: 'sshd', args: [], exe: '/usr/sbin/sshd',
  });
  const dhcp = new OSService({
    name: 'Dhcp', execStart: 'svchost', user: 'NT AUTHORITY\\LocalService',
  });

  it('allow when all required services are active and processes are alive', () => {
    dhcp.state = 'active';
    const gate = new OSFeatureGate({
      services: () => [dhcp],
      processes: () => [sshd],
    });
    const r = gate.require({ services: ['Dhcp'], processes: ['sshd'] });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('deny when a required service is not active — explains why', () => {
    dhcp.state = 'inactive';
    const gate = new OSFeatureGate({
      services: () => [dhcp],
      processes: () => [sshd],
    });
    const r = gate.require({ services: ['Dhcp'] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/Dhcp.*not running/i);
  });

  it('deny when a required service does not exist at all', () => {
    const gate = new OSFeatureGate({
      services: () => [], processes: () => [],
    });
    const r = gate.require({ services: ['MissingSvc'] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/MissingSvc.*does not exist/i);
  });

  it('deny when a required process comm is not in the table', () => {
    const gate = new OSFeatureGate({
      services: () => [], processes: () => [],
    });
    const r = gate.require({ processes: ['sshd'] });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/sshd.*not running/i);
  });
});

// ─── OSServiceOrchestrator ────────────────────────────────────────────

describe('OSServiceOrchestrator — dependency resolution + lifecycle', () => {
  let orch: OSServiceOrchestrator;
  let a: OSService, b: OSService, c: OSService;

  beforeEach(() => {
    a = new OSService({ name: 'A', execStart: '/a', user: 'root' });
    b = new OSService({ name: 'B', execStart: '/b', user: 'root', dependsOn: ['A'] });
    c = new OSService({ name: 'C', execStart: '/c', user: 'root', dependsOn: ['B'] });
    orch = new OSServiceOrchestrator({ services: () => [a, b, c] });
  });

  it('resolveStartOrder returns deps before dependents', () => {
    const order = orch.resolveStartOrder('C');
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('resolveStopOrder is the reverse', () => {
    const order = orch.resolveStopOrder('A');
    // Stopping A must stop everything that depends on it first.
    expect(order).toEqual(['C', 'B', 'A']);
  });

  it('detects dependency cycles with a clear error', () => {
    a.dependsOn = ['C']; // A → C → B → A
    expect(() => orch.resolveStartOrder('C'))
      .toThrow(/cycle/i);
  });
});
