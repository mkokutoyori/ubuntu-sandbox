/*
 * find evaluated every predicate as one flat AND: `-o`, `-prune`, `( )` and `-a`
 * were skipped, so `find / -perm -4000 -o -perm -2000` answered like an AND,
 * and -regex, -links, -uid, -gid, -printf, -quit, -nouser, -daystart were
 * accepted and ignored. The expression is now parsed with the GNU grammar
 * (-o < -a < ! < primary, implicit -a, an action suppresses the default -print)
 * and evaluated per inode, each leaf reusing VirtualFileSystem.matchesFindCriteria.
 *
 * The lab is the same for every case: /tmp/tmp/t/a.txt (2 bytes), /tmp/t/b.log, /tmp/t/sub/c.txt,
 * /tmp/t/sub/deep/d.txt, /tmp/t/exe (mode 4755), /tmp/t/grp (mode 2755), /tmp/t/plain (mode 0644).
 *
 * Measured before the change: 24 cases, 17 fall (every case whose answer depends
 * on -o, -prune, parentheses, !, -regex, -uid, -printf, -quit, -nouser or the
 * refusals of a malformed expression); 7 pass either way: the 6 witnesses (single
 * predicates and the default print) and -links, which the old code ignored and
 * which happens to answer the same on this lab. GNU diagnostics wording and the -regex
 * emacs dialect are from memory of findutils, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function find(args: string): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(
    'mkdir -p /tmp/t/sub/deep; printf hi > /tmp/t/a.txt; printf x > /tmp/t/b.log; printf y > /tmp/t/sub/c.txt; printf z > /tmp/t/sub/deep/d.txt; '
    + 'printf e > /tmp/t/exe; chmod 4755 /tmp/t/exe; printf g > /tmp/t/grp; chmod 2755 /tmp/t/grp; printf p > /tmp/t/plain; chmod 644 /tmp/t/plain',
  );
  return machine.executeCommand(`find /tmp/t ${args}`);
}

const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '').sort();

describe('witnesses', () => {
  it('a single -name', async () => { expect(lines(await find('-name "*.txt"'))).toEqual(['/tmp/t/a.txt', '/tmp/t/sub/c.txt', '/tmp/t/sub/deep/d.txt']); });
  it('two tests are ANDed', async () => { expect(lines(await find('-type f -name "c*"'))).toEqual(['/tmp/t/sub/c.txt']); });
  it('-maxdepth 1 -type f', async () => { expect(lines(await find('-maxdepth 1 -type f'))).toEqual(['/tmp/t/a.txt', '/tmp/t/b.log', '/tmp/t/exe', '/tmp/t/grp', '/tmp/t/plain']); });
  it('-perm -4000', async () => { expect(lines(await find('-perm -4000'))).toEqual(['/tmp/t/exe']); });
  it('an explicit -print equals the default', async () => { expect(lines(await find('-name b.log -print'))).toEqual(['/tmp/t/b.log']); });
  it('-size -2 with -type f', async () => { expect(lines(await find('-type f -size -2 -name "b*"'))).toEqual(['/tmp/t/b.log']); });
});

describe('the expression tree', () => {
  it('-o is a union, not an intersection', async () => {
    expect(lines(await find('-name a.txt -o -name b.log'))).toEqual(['/tmp/t/a.txt', '/tmp/t/b.log']);
  });
  it('setuid or setgid files', async () => {
    expect(lines(await find('-type f \\( -perm -4000 -o -perm -2000 \\)'))).toEqual(['/tmp/t/exe', '/tmp/t/grp']);
  });
  it('-perm /6000 and the union give the same answer', async () => {
    expect(lines(await find('-type f -perm -4000 -o -type f -perm -2000'))).toEqual(['/tmp/t/exe', '/tmp/t/grp']);
  });
  it('! negates the next primary only', async () => {
    expect(lines(await find('-maxdepth 1 -type f ! -name "*.txt" ! -perm -2000 ! -perm -4000'))).toEqual(['/tmp/t/b.log', '/tmp/t/plain']);
  });
  it('-prune keeps a directory out of the walk', async () => {
    expect(lines(await find('-name sub -prune -o -type f -print'))).toEqual(['/tmp/t/a.txt', '/tmp/t/b.log', '/tmp/t/exe', '/tmp/t/grp', '/tmp/t/plain']);
  });
  it('an action replaces the default print', async () => {
    expect(await find('-name a.txt -printf "%f\\n"')).toBe('a.txt');
  });
  it('-quit stops at the first match', async () => {
    expect((await find('-type f -print -quit')).split('\n')).toHaveLength(1);
  });
  it('-true and -false', async () => {
    expect(lines(await find('-maxdepth 0 -true'))).toEqual(['/tmp/t']);
    expect(lines(await find('-maxdepth 0 -false'))).toEqual([]);
  });
});

describe('predicates that were ignored', () => {
  it('-regex matches the whole path', async () => { expect(lines(await find('-regex ".*/c\\.txt"'))).toEqual(['/tmp/t/sub/c.txt']); });
  it('-iregex ignores the case', async () => { expect(lines(await find('-iregex ".*/B\\.LOG"'))).toEqual(['/tmp/t/b.log']); });
  it('-links counts hard links', async () => { expect(lines(await find('-type f -links 1 -name a.txt'))).toEqual(['/tmp/t/a.txt']); });
  it('-uid selects by numeric owner', async () => { expect(lines(await find('-maxdepth 1 -type f -uid 12345'))).toEqual([]); });
  it('-printf formats size, mode and name', async () => { expect(await find('-name exe -printf "%s %m %f\\n"')).toBe('1 4755 exe'); });
  it('-nouser matches nothing on a lab where every owner exists', async () => { expect(lines(await find('-nouser'))).toEqual([]); });
});

describe('malformed expressions are refused', () => {
  it('a missing closing parenthesis', async () => {
    expect(await find('\\( -name a.txt')).toContain("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
  });
  it('a missing argument', async () => { expect(await find('-name')).toBe("find: missing argument to `-name'"); });
  it('a path after the expression', async () => { expect(await find('-name a.txt /tmp')).toBe("find: paths must precede expression: `/tmp'\nfind: possible unquoted pattern after predicate `-name'?"); });
  it('an unknown user', async () => { expect(await find('-user zorglub')).toBe("find: 'zorglub' is not the name of a known user"); });
});
