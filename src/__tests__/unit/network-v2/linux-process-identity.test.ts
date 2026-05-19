/**
 * Unit tests — interactive shell process identity.
 *
 * The debug transcript showed `$$` returning a different random value on
 * every reference, `$PPID` empty, and `ps -p $$` never matching the
 * shell. The interactive `-bash` must own a stable PID that `$$`,
 * `$PPID` and `ps` all agree on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('interactive shell identity', () => {
  it('$$ is stable across references', async () => {
    const pc = new LinuxPC('linux-pc', 'ID-PC', 10, 10);
    const a = (await pc.executeCommand('echo $$')).trim();
    const b = (await pc.executeCommand('echo $$')).trim();
    expect(a).toBe(b);
    expect(Number(a)).toBeGreaterThan(0);
  });

  it('$$ matches the -bash entry reported by ps', async () => {
    const pc = new LinuxPC('linux-pc', 'ID-PC', 10, 10);
    const pid = (await pc.executeCommand('echo $$')).trim();
    const out = await pc.executeCommand(`ps -p ${pid}`);
    expect(out).toContain('-bash');
  });

  it('$PPID is defined and numeric', async () => {
    const pc = new LinuxPC('linux-pc', 'ID-PC', 10, 10);
    const ppid = (await pc.executeCommand('echo $PPID')).trim();
    expect(ppid).toMatch(/^\d+$/);
  });

  it('$$ and $PPID expand together inside one string', async () => {
    const pc = new LinuxPC('linux-pc', 'ID-PC', 10, 10);
    const out = (await pc.executeCommand('echo "pid=$$ ppid=$PPID"')).trim();
    expect(out).toMatch(/^pid=\d+ ppid=\d+$/);
  });
});
