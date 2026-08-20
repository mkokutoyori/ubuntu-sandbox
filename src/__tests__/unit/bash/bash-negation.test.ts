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

describe('! pipeline negation', () => {
  it('inverts a failing command into success', () => {
    expect(run('! false && echo negated')).toContain('negated');
  });

  it('inverts a succeeding command into failure', () => {
    expect(run('! true; echo rc=$?')).toContain('rc=1');
  });

  it('reports zero for a negated failure', () => {
    expect(run('! false; echo rc=$?')).toContain('rc=0');
  });

  it('applies to the whole pipeline, not the first stage', () => {
    expect(run('! false | true; echo rc=$?')).toContain('rc=1');
    expect(run('! true | false; echo rc=$?')).toContain('rc=0');
  });

  it('double negation restores the original status', () => {
    expect(run('! ! true; echo rc=$?')).toContain('rc=0');
    expect(run('! ! false; echo rc=$?')).toContain('rc=1');
  });

  it('a negated failure does not trip set -e', () => {
    const out = runScript(`
      set -e
      ! false
      echo survived
    `);
    expect(out).toContain('survived');
  });

  it('a negated success does not trip set -e either (bash semantics)', () => {
    const out = runScript(`
      set -e
      ! true
      echo survived
    `);
    expect(out).toContain('survived');
  });

  it('does not fire the ERR trap for a negated pipeline', () => {
    const out = runScript(`
      trap 'echo "ERR fired"' ERR
      ! true
      echo done
    `);
    expect(out).not.toContain('ERR fired');
    expect(out).toContain('done');
  });

  it('works inside an if condition', () => {
    expect(run('if ! false; then echo yes; fi')).toContain('yes');
  });

  it('works inside a while guard', () => {
    const out = runScript(`
      n=0
      while ! [ $n -ge 2 ]; do
        echo n=$n
        n=$((n+1))
      done
    `);
    expect(out).toContain('n=0');
    expect(out).toContain('n=1');
  });

  it('a literal ! amid arguments stays an ordinary word', () => {
    expect(run('echo a ! b')).toContain('a ! b');
  });
});
