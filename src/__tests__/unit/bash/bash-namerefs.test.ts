import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }
async function runScript(body: string): Promise<string> {
  exec.vfs.writeFile('/tmp/__t.sh', body, 0, 0, 0o022);
  const i = exec.vfs.resolveInode('/tmp/__t.sh');
  if (i) i.permissions = 0o755;
  return await run('bash /tmp/__t.sh');
}

describe('declare -n namerefs', () => {
  it('reading through the reference yields the target value', async () => {
    expect(await run('declare -n ref=target; target=hi; echo $ref')).toContain('hi');
  });

  it('writing through the reference updates the target', async () => {
    expect(await run('declare -n ref=target; ref=world; echo $target')).toContain('world');
  });

  it('follows a chain of references', async () => {
    expect(await run('declare -n a=b; declare -n b=c; c=deep; echo $a')).toContain('deep');
  });

  it('reads empty when the target is unset', async () => {
    expect(await run('declare -n ref=nothing; echo "[$ref]"')).toContain('[]');
  });

  it('local -n implements out-parameters in functions', async () => {
    const out = await runScript(`
      assign() {
        local -n out=$1
        out=42
      }
      assign result
      echo "result=$result"
    `);
    expect(out).toContain('result=42');
  });

  it('two calls can target different variables', async () => {
    const out = await runScript(`
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
