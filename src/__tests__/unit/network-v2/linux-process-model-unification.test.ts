import { describe, it, expect } from 'vitest';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { OSProcess } from '@/network/devices/os/OSProcess';

describe('Linux processes are backed by the rich OSProcess model', () => {
  it('spawned processes are OSProcess instances exposing the rich fields', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({ command: '/bin/x', comm: 'x', user: 'root', uid: 0, gid: 0 });
    const live = pm.get(p.pid)!;
    expect(live).toBeInstanceOf(OSProcess);
    const rich = live as unknown as OSProcess;
    expect(rich.euid).toBe(0);
    expect(rich.rlimits).toBeDefined();
    expect(typeof rich.numThreads).toBe('number');
    expect(Array.isArray(rich.openFiles)).toBe(true);
  });

  it('the ProcessInfo view still exposes the fields ps/top read', () => {
    const pm = new LinuxProcessManager();
    const p = pm.spawn({ command: '/bin/y arg', comm: 'y', user: 'root', uid: 0, gid: 0 });
    const info = pm.get(p.pid)!;
    expect(info.pid).toBe(p.pid);
    expect(info.comm).toBe('y');
    expect(info.cpuTime).toBe(0);
    expect(info.state).toBe('S');
    expect(info.priority).toBe(20);
  });
});
