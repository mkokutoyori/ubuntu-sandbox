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

describe('trap ERR — fires after every command that returns non-zero', () => {
  it('fires when a top-level command fails', () => {
    const out = runScript(`
      trap 'echo "trap-err"' ERR
      false
      echo "after"
    `);
    expect(out).toContain('trap-err');
    expect(out).toContain('after');
  });

  it('fires once per failing command, not once per script', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      false
      false
      true
      false
    `);
    const count = (out.match(/ERR fired/g) ?? []).length;
    expect(count).toBe(3);
  });

  it('does not fire inside the guard part of an && chain', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      false && echo ok
      echo done
    `);
    // The left side of && is itself a guard, so its failure must NOT
    // trigger ERR (same gate as set -e).
    expect(out).not.toContain('ERR fired');
    expect(out).toContain('done');
  });

  it('does not fire inside an `if` condition', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      if false; then
        echo "then"
      fi
      echo done
    `);
    expect(out).not.toContain('ERR fired');
    expect(out).toContain('done');
  });

  it('does not fire inside a `while` condition', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      i=0
      while [ "$i" -lt 0 ]; do echo loop; done
      echo done
    `);
    expect(out).not.toContain('ERR fired');
    expect(out).toContain('done');
  });

  it('does not re-fire while the handler itself runs', () => {
    const out = runScript(`
      trap 'false; echo "ERR-inside"' ERR
      false
      echo done
    `);
    // The inner false must not trigger another ERR dispatch — exactly
    // one invocation observed.
    expect((out.match(/ERR-inside/g) ?? []).length).toBe(1);
    expect(out).toContain('done');
  });

  it('preserves $? for the script after the handler runs', () => {
    const out = runScript(`
      trap 'true' ERR
      false
      echo "exit=$?"
    `);
    // Handler ran but `$?` must still reflect the failing command's 1,
    // not the handler's own success.
    expect(out).toContain('exit=1');
  });

  it('trap - ERR removes the handler', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      false
      trap - ERR
      false
      echo done
    `);
    expect((out.match(/ERR fired/g) ?? []).length).toBe(1);
    expect(out).toContain('done');
  });

  it('works together with set -e — ERR fires before the script aborts', () => {
    const out = runScript(`
      set -e
      trap 'echo "cleanup"' ERR
      false
      echo "unreachable"
    `);
    expect(out).toContain('cleanup');
    expect(out).not.toContain('unreachable');
  });
});

describe('trap DEBUG — fires before every simple command', () => {
  it('fires before each user command in the script', () => {
    const out = runScript(`
      trap 'echo "DBG"' DEBUG
      echo one
      echo two
    `);
    // 1 for "trap …" itself + 1 for each subsequent echo = 3.
    const count = (out.match(/DBG/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(out).toContain('one');
    expect(out).toContain('two');
  });

  it('does not recurse into itself from within the handler', () => {
    const out = runScript(`
      trap 'echo "DBG"' DEBUG
      echo go
    `);
    // The 'echo "DBG"' inside the handler would otherwise re-trigger
    // DEBUG ad infinitum — bound by the in-trap re-entry guard.
    expect(out.length).toBeLessThan(500);
    expect(out).toContain('go');
  });

  it('preserves $? across the handler invocation', () => {
    const out = runScript(`
      trap 'true' DEBUG
      false
      echo "exit=$?"
    `);
    expect(out).toContain('exit=1');
  });

  it('trap - DEBUG clears the handler', () => {
    const out = runScript(`
      trap 'echo "DBG"' DEBUG
      trap - DEBUG
      echo end
    `);
    expect(out).not.toMatch(/DBG[\s\S]*DBG/);
    expect(out).toContain('end');
  });
});

describe('trap RETURN — fires when a function returns', () => {
  it('fires when a function ends by falling off the body', () => {
    const out = runScript(`
      trap 'echo "RET"' RETURN
      f() { echo "inside"; }
      f
      echo after
    `);
    expect(out).toContain('inside');
    expect(out).toContain('RET');
    expect(out).toContain('after');
  });

  it('fires when a function uses the `return` builtin', () => {
    const out = runScript(`
      trap 'echo "RET"' RETURN
      f() { return 7; }
      f
      echo "code=$?"
    `);
    expect(out).toContain('RET');
    expect(out).toContain('code=7');
  });

  it('does not fire for top-level commands', () => {
    const out = runScript(`
      trap 'echo "RET"' RETURN
      echo plain
    `);
    expect(out).not.toContain('RET');
    expect(out).toContain('plain');
  });

  it('fires once per function call (not once per command inside)', () => {
    const out = runScript(`
      trap 'echo "RET"' RETURN
      f() { echo a; echo b; echo c; }
      f
    `);
    expect((out.match(/RET/g) ?? []).length).toBe(1);
  });

  it('trap - RETURN clears the handler', () => {
    const out = runScript(`
      trap 'echo "RET"' RETURN
      trap - RETURN
      f() { echo inside; }
      f
      echo done
    `);
    expect(out).not.toContain('RET');
    expect(out).toContain('done');
  });
});

describe('trap — combined handlers do not interfere', () => {
  it('ERR + RETURN + DEBUG can coexist', () => {
    const out = runScript(`
      trap 'echo "DBG"' DEBUG
      trap 'echo "ERR"' ERR
      trap 'echo "RET"' RETURN
      f() { false; }
      f
      echo end
    `);
    // The failing 'false' inside f triggers ERR; f returning triggers
    // RETURN; DEBUG fires before each simple command.
    expect(out).toContain('ERR');
    expect(out).toContain('RET');
    expect(out).toContain('DBG');
    expect(out).toContain('end');
  });
});
