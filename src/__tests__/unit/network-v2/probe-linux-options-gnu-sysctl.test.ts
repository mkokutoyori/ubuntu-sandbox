/*
 * sysctl ignored an unknown option (`sysctl --zorglub` and `sysctl -Z` ran as
 * a plain listing). procps-ng prints the getopt line and its usage block on
 * stderr. The first line is getopt's; the usage block is copied from the real
 * binary of the dev container (procps-ng 4.0.4). Ubuntu 22.04 ships 3.3.17,
 * whose block may differ in the descriptions of --dry-run, -o and -x.
 *
 * Measured with `git stash`: 6 cases, 2 fall before the change (the two
 * refusals); the 4 witnesses (read, write, -n, -N) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('sysctl refuses what it does not know', () => {
  it('a long option', async () => {
    const out = await pc().executeCommand('sysctl --zorglub');
    expect(out.split('\n')[0]).toBe("sysctl: unrecognized option '--zorglub'");
    expect(out).toContain('\nUsage:\n sysctl [options] [variable[=value] ...]\n');
    expect(out.endsWith('\nFor more details see sysctl(8).')).toBe(true);
  });
  it('a short option, with status 1', async () => {
    const out = await pc().executeCommand('sysctl -Z; echo $?');
    expect(out.split('\n')[0]).toBe("sysctl: invalid option -- 'Z'");
    expect(out.endsWith('\n1')).toBe(true);
  });
});

describe('witness: known options still work', () => {
  it('-n', async () => { expect(await pc().executeCommand('sysctl -n net.ipv4.ip_forward')).toBe('0'); });
  it('-N', async () => { expect(await pc().executeCommand('sysctl -N net.ipv4.ip_forward')).toBe('net.ipv4.ip_forward'); });
  it('read', async () => { expect(await pc().executeCommand('sysctl net.ipv4.ip_forward')).toBe('net.ipv4.ip_forward = 0'); });
  it('-w', async () => { expect(await pc().executeCommand('sysctl -w net.ipv4.ip_forward=0')).toBe('net.ipv4.ip_forward = 0'); });
});
