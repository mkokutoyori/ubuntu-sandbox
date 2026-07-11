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

describe('extglob in parameter-expansion patterns', () => {
  it('+(...) matches one or more in a suffix strip', async () => {
    expect(await run('v=fooooo; echo ${v%%+(o)}')).toContain('f');
  });

  it('*(...) matches zero or more', async () => {
    expect(await run('v=abcabc; echo ${v##*(abc)}')).toContain('');
    expect(await run('v=xabc; echo "[${v##*(abc)}]"')).toContain('[xabc]');
  });

  it('?(...) matches zero or one', async () => {
    expect(await run('v=color; echo ${v/colo?(u)r/MATCH}')).toContain('MATCH');
    expect(await run('v=colour; echo ${v/colo?(u)r/MATCH}')).toContain('MATCH');
  });

  it('@(a|b) matches exactly one alternative', async () => {
    expect(await run('v=cat; echo ${v/@(cat|dog)/pet}')).toContain('pet');
    expect(await run('v=dog; echo ${v/@(cat|dog)/pet}')).toContain('pet');
  });

  it('!(...) negates the alternatives', async () => {
    expect(await run('v=hello.txt; echo ${v%.!(png)}')).toContain('hello');
  });

  it('alternation inside +(...) strips a repeated group', async () => {
    expect(await run('v=abcABCabc; echo ${v##+(abc|ABC)}')).toContain('');
  });

  it('a plain glob still works alongside extglob', async () => {
    expect(await run('v=file.tar.gz; echo ${v%.*}')).toContain('file.tar');
  });

  it('prefix strip with @(...) removes exactly one match', async () => {
    expect(await run('v=prefoo; echo ${v#@(pre|post)}')).toContain('foo');
  });
});
