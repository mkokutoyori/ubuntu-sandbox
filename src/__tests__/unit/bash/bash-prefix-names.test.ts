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

describe('${!prefix*} / ${!prefix@} variable-name enumeration', () => {
  it('lists variable names sharing a prefix, sorted', () => {
    const out = run('USER_a=1; USER_b=2; USER_c=3; echo ${!USER_*}');
    expect(out).toContain('USER_a USER_b USER_c');
  });

  it('@ form yields the same names when unquoted', () => {
    const out = run('P1=x; P2=y; echo ${!P@}');
    expect(out).toContain('P1 P2');
  });

  it('excludes names that do not match the prefix', () => {
    const out = run('APP_x=1; OTHER=2; APP_y=3; echo ${!APP_*}');
    expect(out).toContain('APP_x APP_y');
    expect(out).not.toContain('OTHER');
  });

  it('yields nothing for an unmatched prefix', () => {
    expect(run('echo "[${!NONE_*}]"')).toContain('[]');
  });

  it('quoted @ form splits into separate words', () => {
    const out = run('Z1=a; Z2=b; for n in "${!Z@}"; do echo "name=$n"; done');
    expect(out).toContain('name=Z1');
    expect(out).toContain('name=Z2');
  });
});
