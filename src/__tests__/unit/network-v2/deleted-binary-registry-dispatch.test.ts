/**
 * docs/PRD-Pannes.md §F7.7 — a deleted binary stops the command, however
 * that command is dispatched.
 *
 * The guard existed, at the top of `dispatch()`'s switch. But a command
 * served by the REGISTRY never goes through it: it arrives via
 * `tryNetworkCommand` (bare command) or via bash's runner (compound line,
 * pipe, script). Measured with `curl` as the control: `rm /usr/bin/curl`
 * then `curl` still worked — and likewise for `xxd`, `bc`, `nmap`,
 * `nginx`, `ss`, `nc`, `openssl`.
 *
 * An `rm` that does nothing teaches that the command comes from no file,
 * which is the exact opposite of the lesson.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'BIN'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

describe('§F7.7 — a deleted binary stops a registry command', () => {
  for (const [name, path, invocation] of [
    ['curl', '/usr/bin/curl', 'curl -sS http://127.0.0.1/'],
    ['openssl', '/usr/bin/openssl', 'openssl version'],
  ] as const) {
    it(`${name}: present it answers, deleted it fails`, async () => {
      const srv = machine(`M-${name}`);
      expect(await srv.executeCommand(invocation)).not.toMatch(/No such file or directory/);

      await srv.executeCommand(`rm ${path}`);

      const out = await srv.executeCommand(invocation);
      expect(out).toContain(`${path}: No such file or directory`);
    });
  }

  it('the exit code is 127, the shell\'s "cannot exec"', async () => {
    const srv = machine();
    await srv.executeCommand('rm /usr/bin/curl');

    const code = (await srv.executeCommand(
      `sh -c 'curl -sS http://127.0.0.1/ ; echo $?'`)).trim().split('\n').pop();

    expect(code).toBe('127');
  });

  it('a compound line fails like the bare command', async () => {
    const srv = machine();
    await srv.executeCommand('rm /usr/bin/openssl');

    // Three dispatch paths, one answer: otherwise `rm` would only affect
    // some ways of typing the command.
    const bare = await srv.executeCommand('openssl version');
    const compound = await srv.executeCommand(`sh -c 'openssl version || echo FAILED'`);
    const piped = await srv.executeCommand('openssl version | cat');

    expect(bare).toContain('No such file or directory');
    expect(compound).toContain('FAILED');
    expect(piped).toContain('No such file or directory');
  });

  it('putting the file back brings the command back', async () => {
    const srv = machine();
    await srv.executeCommand('rm /usr/bin/openssl');
    expect(await srv.executeCommand('openssl version')).toContain('No such file');

    await srv.executeCommand(`sh -c 'echo binary > /usr/bin/openssl'`);

    expect(await srv.executeCommand('openssl version')).toContain('OpenSSL 3.0.2');
  });

  it('a command the image does NOT ship is never judged missing', async () => {
    const srv = machine();

    // The guard's own guard: only a binary the image really lays down at
    // boot can be declared missing. `ss` is the example — it has neither a
    // table entry nor a `binaryPath`, so `/usr/bin/ss` does not exist and
    // its `rm` proves nothing. Without this reservation, every registry
    // command with no file would become unreachable.
    await srv.executeCommand('rm /usr/bin/ss');
    expect(await srv.executeCommand('ss -ltn')).toContain('LISTEN');
    expect(await srv.executeCommand('ping -c 1 127.0.0.1')).not.toContain('No such file or directory');
  });

  /**
   * THE GUARD'S GUARD, and it is necessary.
   *
   * Now that the guard also judges on the `binaryPath` a command declares,
   * a command declaring one WITHOUT the image laying it down at boot would
   * become permanently unreachable — it would fail on a file nobody ever
   * deleted. The ones declaring a path today are all seeded; this case is
   * here so the next one notices it here rather than in production.
   */
  it('every declared binaryPath is really laid down at boot', async () => {
    const srv = machine('DECLARED');

    for (const path of [
      '/usr/bin/openssl', '/usr/sbin/nginx', '/usr/sbin/apachectl',
      '/usr/sbin/conntrack', '/usr/sbin/lid',
      '/usr/sbin/lsmod', '/usr/sbin/modinfo', '/usr/sbin/swapon', '/usr/sbin/swapoff',
    ]) {
      expect(await srv.executeCommand(`ls ${path}`), `${path} declared but absent at boot`)
        .not.toContain('No such file');
    }
  });
});
