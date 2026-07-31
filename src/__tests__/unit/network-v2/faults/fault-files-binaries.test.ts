/**
 * F7.7 — deleting a binary or a command's key file must break the command.
 *
 * The mechanism is declarative: `STANDARD_BIN_PATHS` names where each
 * shipped command lives, those paths are seeded at boot, and the dispatcher
 * refuses to run a command whose file the user has since removed
 * (docs/PRD-Pannes.md §6.2, §F7.7).
 *
 * The guard-rail is as important as the feature: only binaries the image
 * really ships can be judged missing, so a name that was never on disk —
 * a shell builtin, a command this build does not provide — is unaffected.
 * Without that, the check would fire on the simulator's hottest path for
 * every fixture that never provisioned a filesystem.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  STANDARD_BIN_PATHS, resolveExePath, checkCommandDependencies,
  firstMissingRequirement, canonicalBinPath,
} from '@/network/devices/linux/service/CriticalFiles';

function pc(): LinuxPC {
  EquipmentRegistry.getInstance().clear();
  return new LinuxPC('linux-pc', 'PC1');
}

const run = (d: LinuxPC, cmd: string) => d.executeCommand(cmd);

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

describe('the binary table', () => {
  it('maps a command to its real Ubuntu path', () => {
    expect(resolveExePath('ls')).toBe('/bin/ls');
    expect(resolveExePath('ssh')).toBe('/usr/bin/ssh');
    expect(resolveExePath('iptables')).toBe('/usr/sbin/iptables');
  });

  it('seeds every shipped binary at boot, so absence means deletion', async () => {
    const d = pc();
    for (const declared of Object.values(STANDARD_BIN_PATHS)) {
      const path = canonicalBinPath(declared);
      expect(await run(d, `test -e ${path} && echo yes`), path).toContain('yes');
    }
  });
});

describe('F7.7 — a deleted binary', () => {
  it('nominal: ls works', async () => {
    const d = pc();
    expect(await run(d, 'ls /')).toContain('etc');
  });

  it('after the binary is removed, the shell cannot exec it', async () => {
    const d = pc();
    await run(d, 'sudo rm /usr/bin/ls');

    // A real shell reports the PATH it failed to exec, not a generic error.
    expect(await run(d, 'ls /')).toContain('/bin/ls: No such file or directory');
  });

  it('reports exit code 127, which is what scripts branch on', async () => {
    const d = pc();
    await run(d, 'sudo rm /usr/bin/ls');

    expect(await run(d, 'ls / ; echo rc=$?')).toContain('rc=127');
  });

  it('only that command breaks — its neighbours are untouched', async () => {
    const d = pc();
    await run(d, 'sudo rm /usr/bin/ls');

    expect(await run(d, 'echo still-here')).toContain('still-here');
    expect(await run(d, 'cat /etc/hostname')).not.toContain('No such file');
  });

  it('restoring the binary brings the command back', async () => {
    const d = pc();
    await run(d, 'sudo rm /usr/bin/ls');
    expect(await run(d, 'ls /')).toContain('No such file or directory');

    await run(d, "sudo sh -c 'echo x > /usr/bin/ls'");

    expect(await run(d, 'ls /')).toContain('etc');
  });

  it('a name the image never shipped is unaffected by the check', async () => {
    const d = pc();
    // `cd` is a shell builtin: it lives in the process, not on disk, so
    // there is no file whose absence could break it.
    expect(await run(d, 'cd /etc ; pwd')).toContain('/etc');
  });
});

describe('F7.5 — a command whose key file is gone', () => {
  it('nominal: sudo works', async () => {
    const d = pc();
    expect(await run(d, 'sudo whoami')).toContain('root');
  });

  it('`sudo rm /etc/sudoers` makes sudo refuse, with its own message', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/sudoers');

    // Real sudo: the binary is fine, the policy it needs is gone.
    expect(await run(d, 'sudo whoami')).toContain('sudo: /etc/sudoers is required');
  });

  it('the failure is the program refusing (1), not the shell failing to exec (127)', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/sudoers');

    const out = await run(d, 'sudo whoami ; echo rc=$?');
    expect(out).toContain('rc=1');
    expect(out).not.toContain('rc=127');
  });

  it('cannot be repaired with sudo — that is the whole lesson', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/sudoers');

    // The obvious repair is the one thing that no longer works: sudo needs
    // the file it is being asked to restore. A lab that reaches this state
    // is unrecoverable without direct root access, which is exactly why
    // real admins edit sudoers with visudo and never with `rm`
    // (docs/PRD-Pannes.md §F7.5).
    const repair = await run(d, "sudo sh -c 'echo \"root ALL=(ALL:ALL) ALL\" > /etc/sudoers'");
    expect(repair).toContain('sudo: /etc/sudoers is required');
    expect(await run(d, 'sudo whoami')).toContain('sudo: /etc/sudoers is required');
  });

  it('root, who never needed sudo, can still repair it', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/sudoers');
    expect(await run(d, 'sudo whoami')).toContain('is required');

    // Direct root access is the documented way out.
    const vfs = (d as unknown as {
      executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): unknown } };
    }).executor.vfs;
    vfs.writeFile('/etc/sudoers', 'root ALL=(ALL:ALL) ALL\nuser ALL=(ALL:ALL) ALL\n', 0, 0, 0o337);

    expect(await run(d, 'sudo whoami')).toContain('root');
  });
});

describe('the requirement checker itself', () => {
  const probe = (present: readonly string[]) => ({
    exists: (p: string) => present.includes(p),
    readFile: (p: string) => (present.includes(p) ? '' : null),
  });

  it('reports the first unmet requirement, in declaration order', () => {
    const missing = firstMissingRequirement(probe([]), [
      { path: '/a', onMissing: 'a is gone' },
      { path: '/b', onMissing: 'b is gone' },
    ]);
    expect(missing).toBe('a is gone');
  });

  it('an anyOf set is satisfied by any single member', () => {
    const reqs = [{ anyOf: ['/k1', '/k2'], onAllMissing: 'no keys' }];
    expect(firstMissingRequirement(probe(['/k2']), reqs)).toBeNull();
    expect(firstMissingRequirement(probe([]), reqs)).toBe('no keys');
  });

  it('stands aside for a binary the image does not ship', () => {
    // Nothing exists in this probe at all, yet an unknown command must not
    // be reported missing — that is the guard-rail.
    expect(checkCommandDependencies(probe([]), 'some-unshipped-tool')).toBeNull();
  });

  it('but does judge a shipped binary that is absent', () => {
    expect(checkCommandDependencies(probe([]), 'ls')).toEqual({
      message: 'bash: /bin/ls: No such file or directory',
      exitCode: 127,
    });
  });
});
