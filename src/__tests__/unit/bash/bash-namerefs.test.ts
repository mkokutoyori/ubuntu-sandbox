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

describe('declare -n namerefs', () => {
  it('reading through the reference yields the target value', () => {
    expect(run('declare -n ref=target; target=hi; echo $ref')).toContain('hi');
  });

  it('writing through the reference updates the target', () => {
    expect(run('declare -n ref=target; ref=world; echo $target')).toContain('world');
  });

  it('follows a chain of references', () => {
    expect(run('declare -n a=b; declare -n b=c; c=deep; echo $a')).toContain('deep');
  });

  it('reads empty when the target is unset', () => {
    expect(run('declare -n ref=nothing; echo "[$ref]"')).toContain('[]');
  });

  it('local -n implements out-parameters in functions', () => {
    const out = runScript(`
      assign() {
        local -n out=$1
        out=42
      }
      assign result
      echo "result=$result"
    `);
    expect(out).toContain('result=42');
  });

  it('two calls can target different variables', () => {
    const out = runScript(`
      setv() {
        local -n slot=$1
        slot=$2
      }
      setv first one
      setv second two
      echo "$first-$second"
    `);
    expect(out).toContain('one-two');
  });
});
