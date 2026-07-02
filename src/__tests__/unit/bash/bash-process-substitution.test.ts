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

describe('process substitution <(list)', () => {
  it('cat reads the output of the substituted command', () => {
    expect(run('cat <(echo hello)')).toContain('hello');
  });

  it('diff sees identical substituted streams as equal', () => {
    expect(run('diff <(echo a) <(echo a) && echo SAME')).toContain('SAME');
  });

  it('diff reports differing substituted streams', () => {
    const out = run('diff <(echo a) <(echo b) >/dev/null 2>&1; echo rc=$?');
    expect(out).toMatch(/rc=1\b/);
  });

  it('feeds a while-read loop through a redirected substitution', () => {
    const out = run('while read l; do echo "got:$l"; done < <(printf "x\\ny\\n")');
    expect(out).toContain('got:x');
    expect(out).toContain('got:y');
  });

  it('two substitutions in one command get distinct paths', () => {
    const out = run('echo <(true) <(true)').trim();
    const paths = out.split(/\s+/);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0]).toMatch(/\/(dev\/fd|tmp)\//);
  });

  it('the substituted list sees variable expansion', () => {
    expect(run('v=world; cat <(echo "hi $v")')).toContain('hi world');
  });

  it('sorting two substituted streams works end to end', () => {
    exec.vfs.writeFile('/tmp/a.txt', 'b\na\n', 0, 0, 0o022);
    exec.vfs.writeFile('/tmp/b.txt', 'a\nb\n', 0, 0, 0o022);
    expect(run('diff <(sort /tmp/a.txt) <(sort /tmp/b.txt) && echo EQUAL')).toContain('EQUAL');
  });
});

describe('process substitution >(list)', () => {
  it('writes redirected output through the consumer command', () => {
    run('echo captured > >(cat > /tmp/psub-out.txt)');
    expect(run('cat /tmp/psub-out.txt')).toContain('captured');
  });

  it('the consumer can transform the stream', () => {
    run('printf "b\\na\\n" > >(sort > /tmp/psub-sorted.txt)');
    const out = run('cat /tmp/psub-sorted.txt');
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
  });
});
