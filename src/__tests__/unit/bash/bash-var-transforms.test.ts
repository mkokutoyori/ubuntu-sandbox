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

describe('${var@X} parameter transformations', () => {
  it('@Q quotes a plain value for reuse', () => {
    expect(run("v='a b'; echo ${v@Q}")).toContain("'a b'");
  });

  it('@Q escapes embedded single quotes the bash way', () => {
    expect(run('v="it\'s"; echo ${v@Q}')).toContain("'it'\\''s'");
  });

  it('@U uppercases the whole value', () => {
    expect(run('v=hello; echo ${v@U}')).toContain('HELLO');
  });

  it('@L lowercases the whole value', () => {
    expect(run('v=HELLO; echo ${v@L}')).toContain('hello');
  });

  it('@u uppercases only the first character', () => {
    expect(run('v=hello world; v=hello; echo ${v@u}')).toContain('Hello');
  });

  it('works inside double quotes', () => {
    expect(run('v=abc; echo "up=${v@U}"')).toContain('up=ABC');
  });

  it('an unset variable transforms to the empty string', () => {
    expect(run('unset novar; echo "[${novar@U}]"')).toContain('[]');
  });
});
