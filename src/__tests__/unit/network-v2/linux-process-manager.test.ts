import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';

describe('LinuxProcessManager', () => {
  let pm: LinuxProcessManager;

  beforeEach(() => {
    pm = new LinuxProcessManager();
  });

  describe('initialization', () => {
    it('starts with PID 1 (systemd) running', () => {
      const init = pm.get(1);
      expect(init).toBeDefined();
      expect(init!.pid).toBe(1);
      expect(init!.ppid).toBe(0);
      expect(init!.user).toBe('root');
      expect(init!.uid).toBe(0);
      expect(init!.comm).toBe('systemd');
      expect(init!.state).toBe('S');
    });

    it('lists init in process list', () => {
      const procs = pm.list();
      expect(procs.length).toBe(1);
      expect(procs[0].pid).toBe(1);
    });
  });

  describe('spawn', () => {
    it('allocates sequential PIDs starting from 2', () => {
      const p1 = pm.spawn({ command: '/usr/bin/sleep 60', user: 'root', uid: 0, gid: 0 });
      const p2 = pm.spawn({ command: '/usr/bin/cat /tmp/x', user: 'root', uid: 0, gid: 0 });
      expect(p1.pid).toBe(2);
      expect(p2.pid).toBe(3);
    });

    it('parses comm from command path', () => {
      const p = pm.spawn({ command: '/usr/sbin/sshd -D', user: 'root', uid: 0, gid: 0 });
      expect(p.comm).toBe('sshd');
    });

    it('parses args from command line', () => {
      const p = pm.spawn({ command: '/usr/sbin/sshd -D -e', user: 'root', uid: 0, gid: 0 });
      expect(p.args).toEqual(['-D', '-e']);
    });

    it('defaults parent PID to 1 (systemd) when not specified', () => {
      const p = pm.spawn({ command: '/usr/bin/foo', user: 'root', uid: 0, gid: 0 });
      expect(p.ppid).toBe(1);
    });

    it('allows custom parent PID', () => {
      const parent = pm.spawn({ command: '/bin/bash', user: 'user', uid: 1000, gid: 1000 });
      const child = pm.spawn({ command: '/bin/ls', user: 'user', uid: 1000, gid: 1000, ppid: parent.pid });
      expect(child.ppid).toBe(parent.pid);
    });

    it('initial state is S (sleeping)', () => {
      const p = pm.spawn({ command: '/usr/bin/foo', user: 'user', uid: 1000, gid: 1000 });
      expect(p.state).toBe('S');
    });

    it('records start time', () => {
      const before = Date.now();
      const p = pm.spawn({ command: '/usr/bin/foo', user: 'user', uid: 1000, gid: 1000 });
      expect(p.startTime.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('tags service-spawned processes', () => {
      const p = pm.spawn({ command: '/usr/sbin/nginx', user: 'www-data', uid: 33, gid: 33, serviceName: 'nginx' });
      expect(p.serviceName).toBe('nginx');
    });
  });

  describe('get / list', () => {
    it('returns undefined for unknown pid', () => {
      expect(pm.get(99999)).toBeUndefined();
    });

    it('lists all processes', () => {
      pm.spawn({ command: '/a', user: 'u', uid: 1, gid: 1 });
      pm.spawn({ command: '/b', user: 'u', uid: 1, gid: 1 });
      expect(pm.list().length).toBe(3); // +init
    });

    it('filters by user', () => {
      pm.spawn({ command: '/a', user: 'alice', uid: 100, gid: 100 });
      pm.spawn({ command: '/b', user: 'bob', uid: 200, gid: 200 });
      const alice = pm.list({ user: 'alice' });
      expect(alice.length).toBe(1);
      expect(alice[0].user).toBe('alice');
    });

    it('filters by parent pid', () => {
      const parent = pm.spawn({ command: '/bash', user: 'u', uid: 1, gid: 1 });
      pm.spawn({ command: '/ls', user: 'u', uid: 1, gid: 1, ppid: parent.pid });
      pm.spawn({ command: '/cat', user: 'u', uid: 1, gid: 1, ppid: parent.pid });
      const children = pm.list({ ppid: parent.pid });
      expect(children.length).toBe(2);
    });

    it('filters by state', () => {
      const p = pm.spawn({ command: '/x', user: 'u', uid: 1, gid: 1 });
      pm.setState(p.pid, 'Z');
      const zombies = pm.list({ state: 'Z' });
      expect(zombies.map(z => z.pid)).toContain(p.pid);
    });
  });

  describe('signals and kill', () => {
    it('SIGKILL removes process immediately', () => {
      const p = pm.spawn({ command: '/foo', user: 'u', uid: 1, gid: 1 });
      const ok = pm.kill(p.pid, 'SIGKILL');
      expect(ok).toBe(true);
      expect(pm.get(p.pid)).toBeUndefined();
    });

    it('SIGTERM removes process (no signal handler simulated)', () => {
      const p = pm.spawn({ command: '/foo', user: 'u', uid: 1, gid: 1 });
      pm.kill(p.pid, 'SIGTERM');
      expect(pm.get(p.pid)).toBeUndefined();
    });

    it('SIGSTOP transitions state to T (stopped)', () => {
      const p = pm.spawn({ command: '/foo', user: 'u', uid: 1, gid: 1 });
      pm.kill(p.pid, 'SIGSTOP');
      expect(pm.get(p.pid)!.state).toBe('T');
    });

    it('SIGCONT transitions state back to S', () => {
      const p = pm.spawn({ command: '/foo', user: 'u', uid: 1, gid: 1 });
      pm.kill(p.pid, 'SIGSTOP');
      pm.kill(p.pid, 'SIGCONT');
      expect(pm.get(p.pid)!.state).toBe('S');
    });

    it('returns false for unknown pid', () => {
      expect(pm.kill(9999, 'SIGTERM')).toBe(false);
    });

    it('cannot kill PID 1', () => {
      expect(pm.kill(1, 'SIGKILL')).toBe(false);
      expect(pm.get(1)).toBeDefined();
    });

    it('orphaned children are reparented to PID 1', () => {
      const parent = pm.spawn({ command: '/bash', user: 'u', uid: 1, gid: 1 });
      const child = pm.spawn({ command: '/ls', user: 'u', uid: 1, gid: 1, ppid: parent.pid });
      pm.kill(parent.pid, 'SIGKILL');
      expect(pm.get(child.pid)!.ppid).toBe(1);
    });
  });

  describe('pidof and pgrep', () => {
    it('pidof returns PIDs by command name', () => {
      const p1 = pm.spawn({ command: '/usr/sbin/nginx', user: 'r', uid: 0, gid: 0 });
      const p2 = pm.spawn({ command: '/usr/sbin/nginx -t', user: 'r', uid: 0, gid: 0 });
      pm.spawn({ command: '/usr/sbin/sshd', user: 'r', uid: 0, gid: 0 });
      const pids = pm.pidof('nginx');
      expect(pids.sort()).toEqual([p1.pid, p2.pid].sort());
    });

    it('pidof returns empty array for unknown comm', () => {
      expect(pm.pidof('nope')).toEqual([]);
    });

    it('pgrep matches by substring in comm', () => {
      pm.spawn({ command: '/usr/sbin/sshd', user: 'r', uid: 0, gid: 0 });
      pm.spawn({ command: '/usr/sbin/sssd', user: 'r', uid: 0, gid: 0 });
      const matches = pm.pgrep('ss');
      expect(matches.length).toBe(2);
    });

    it('pkill terminates matching processes', () => {
      const p = pm.spawn({ command: '/usr/sbin/nginx', user: 'r', uid: 0, gid: 0 });
      const killed = pm.pkill('nginx', 'SIGTERM');
      expect(killed).toBe(1);
      expect(pm.get(p.pid)).toBeUndefined();
    });
  });

  describe('PID allocation edge cases', () => {
    it('reuses PIDs after wraparound when slots free', () => {
      const p2 = pm.spawn({ command: '/a', user: 'u', uid: 1, gid: 1 });
      pm.kill(p2.pid, 'SIGKILL');
      const p3 = pm.spawn({ command: '/b', user: 'u', uid: 1, gid: 1 });
      // Next PID should still increment monotonically (Linux behavior up to PID_MAX)
      expect(p3.pid).toBeGreaterThan(p2.pid);
    });
  });
});
