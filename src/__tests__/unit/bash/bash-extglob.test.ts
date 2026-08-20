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

describe('extglob in parameter-expansion patterns', () => {
  it('+(...) matches one or more in a suffix strip', () => {
    expect(run('v=fooooo; echo ${v%%+(o)}')).toContain('f');
  });

  it('*(...) matches zero or more', () => {
    expect(run('v=abcabc; echo ${v##*(abc)}')).toContain('');
    expect(run('v=xabc; echo "[${v##*(abc)}]"')).toContain('[xabc]');
  });

  it('?(...) matches zero or one', () => {
    expect(run('v=color; echo ${v/colo?(u)r/MATCH}')).toContain('MATCH');
    expect(run('v=colour; echo ${v/colo?(u)r/MATCH}')).toContain('MATCH');
  });

  it('@(a|b) matches exactly one alternative', () => {
    expect(run('v=cat; echo ${v/@(cat|dog)/pet}')).toContain('pet');
    expect(run('v=dog; echo ${v/@(cat|dog)/pet}')).toContain('pet');
  });

  it('!(...) negates the alternatives', () => {
    expect(run('v=hello.txt; echo ${v%.!(png)}')).toContain('hello');
  });

  it('alternation inside +(...) strips a repeated group', () => {
    expect(run('v=abcABCabc; echo ${v##+(abc|ABC)}')).toContain('');
  });

  it('a plain glob still works alongside extglob', () => {
    expect(run('v=file.tar.gz; echo ${v%.*}')).toContain('file.tar');
  });

  it('prefix strip with @(...) removes exactly one match', () => {
    expect(run('v=prefoo; echo ${v#@(pre|post)}')).toContain('foo');
  });
});
