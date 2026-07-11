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

describe('${!prefix*} / ${!prefix@} variable-name enumeration', () => {
  it('lists variable names sharing a prefix, sorted', async () => {
    const out = await run('USER_a=1; USER_b=2; USER_c=3; echo ${!USER_*}');
    expect(out).toContain('USER_a USER_b USER_c');
  });

  it('@ form yields the same names when unquoted', async () => {
    const out = await run('P1=x; P2=y; echo ${!P@}');
    expect(out).toContain('P1 P2');
  });

  it('excludes names that do not match the prefix', async () => {
    const out = await run('APP_x=1; OTHER=2; APP_y=3; echo ${!APP_*}');
    expect(out).toContain('APP_x APP_y');
    expect(out).not.toContain('OTHER');
  });

  it('yields nothing for an unmatched prefix', async () => {
    expect(await run('echo "[${!NONE_*}]"')).toContain('[]');
  });

  it('quoted @ form splits into separate words', async () => {
    const out = await run('Z1=a; Z2=b; for n in "${!Z@}"; do echo "name=$n"; done');
    expect(out).toContain('name=Z1');
    expect(out).toContain('name=Z2');
  });
});
