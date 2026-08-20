/**
 * A false `if`/`elif` condition (or a plain failing `[ ]`/`[[ ]]` test used
 * as one) must never leak its own nonzero exit status past the `if`
 * construct under `set -e` — POSIX defines the exit status of `if` as
 * "zero if no condition tested true" precisely so a script can probe a
 * condition without aborting. This is the standard idiom real setup
 * scripts use for root/precondition checks, e.g.:
 *   if [[ $EUID -ne 0 ]]; then fail "must be root"; fi
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});
function run(cmd: string): string { return exec.execute(cmd); }
function runScript(body: string): string {
  exec.vfs.writeFile('/tmp/__t.sh', body, 0, 0, 0o022);
  const i = exec.vfs.resolveInode('/tmp/__t.sh');
  if (i) i.permissions = 0o755;
  return run('bash /tmp/__t.sh');
}

describe('if/set -e interaction', () => {
  it('a false `if` condition with no else does not abort the script under set -e', () => {
    const out = runScript(`
      set -e
      if false; then
        echo unreachable
      fi
      echo survived
    `);
    expect(out).toContain('survived');
    expect(out).not.toContain('unreachable');
  });

  it("exit status after a not-taken if is reset to 0, not the condition's status", () => {
    const out = runScript(`
      if false; then
        echo unreachable
      fi
      echo rc=$?
    `);
    expect(out).toContain('rc=0');
  });

  it('a false [ ] test used as an if condition does not abort under set -e', () => {
    const out = runScript(`
      set -e
      if [ 1 -ne 1 ]; then
        echo unreachable
      fi
      echo survived
    `);
    expect(out).toContain('survived');
  });

  it('a false [[ ]] test used as an if condition does not abort under set -e (the EUID root-check idiom)', () => {
    const out = runScript(`
      set -e
      if [[ $EUID -ne 0 ]]; then
        echo FAIL
        exit 1
      fi
      echo root_confirmed
    `);
    expect(out).toContain('root_confirmed');
    expect(out).not.toContain('FAIL');
  });

  it('all elif branches false with no else also resets to 0 under set -e', () => {
    const out = runScript(`
      set -e
      if false; then
        echo a
      elif false; then
        echo b
      fi
      echo survived
    `);
    expect(out).toContain('survived');
  });

  it('a command that genuinely fails INSIDE a taken then-branch still aborts under set -e', () => {
    const out = runScript(`
      set -e
      if true; then
        false
        echo unreachable
      fi
      echo also_unreachable
    `);
    expect(out).not.toContain('unreachable');
    expect(out).not.toContain('also_unreachable');
  });

  it('a bare failing [[ ]] test NOT used as an if condition still aborts under set -e', () => {
    const out = runScript(`
      set -e
      [[ 1 -ne 1 ]]
      echo unreachable
    `);
    expect(out).not.toContain('unreachable');
  });
});
