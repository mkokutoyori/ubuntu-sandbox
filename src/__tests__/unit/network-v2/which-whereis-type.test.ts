/**
 * which / whereis / type — exhaustive behaviour spec.
 *
 * Drives each command through the real Linux executor (PATH-driven
 * resolution, the ShellCatalog of bash builtins/keywords, the alias table,
 * the function map, and the WhereisResolver's directory model) and asserts
 * realistic util-linux / Bash output and exit codes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => { exec = new LinuxCommandExecutor(false); });

function write(path: string, content: string, mode = 0o755): void {
  exec.vfs.writeFile(path, content, 0, 0, 0o022);
  const inode = exec.vfs.resolveInode(path);
  if (inode) inode.permissions = mode;
}
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }

describe('which', () => {
  it('A1 resolves a seeded PATH binary to its directory entry', async () => {
    expect(await run('which iptables')).toContain('/usr/sbin/iptables');
  });
  it('A2 picks the first $PATH match (deterministic order)', async () => {
    expect(await run('which ls')).toBe('/usr/bin/ls');
  });
  it('A3 -a lists every $PATH match in order', async () => {
    exec.vfs.mkdirp('/usr/local/bin', 0o755, 0, 0);
    write('/usr/local/bin/foo', '#!/bin/sh\n');
    write('/usr/bin/foo', '#!/bin/sh\n');
    const lines = (await run('which -a foo')).split('\n');
    expect(lines).toEqual(['/usr/local/bin/foo', '/usr/bin/foo']);
  });
  it('A4 produces no stdout when the name is not in $PATH', async () => {
    expect(await run('which zzznotacommand')).toBe('');
  });
  it('A5 exits 0 when the name is found (chained with &&)', async () => {
    expect(await run('which ls && echo HIT')).toBe('/usr/bin/ls\nHIT');
  });
  it('A6 exits 1 when the name is missing (chained with ||)', async () => {
    expect(await run('which zzznotacommand || echo MISS')).toBe('MISS');
  });
});

describe('whereis', () => {
  it('B1 prints "name: <paths>" for a seeded binary', async () => {
    const out = await run('whereis iptables');
    expect(out).toContain('iptables:');
    expect(out).toContain('/usr/sbin/iptables');
  });
  it('B2 -b limits the output to binaries', async () => {
    expect(await run('whereis -b ls')).toBe('ls: /usr/bin/ls');
  });
  it('B3 -l lists the configured search directories', async () => {
    const out = await run('whereis -l');
    expect(out).toContain('/usr/bin');
    expect(out).toContain('/usr/share/man');
    expect(out).toContain('/usr/src');
  });
  it('B4 surfaces a synthesised location for a known simulator command', async () => {
    expect(await run('whereis -b cd')).toBe('cd: /usr/bin/cd');
  });
  it('B5 processes several names in a single invocation', async () => {
    const out = (await run('whereis ls iptables')).split('\n');
    expect(out[0]).toContain('ls: /usr/bin/ls');
    expect(out[1]).toContain('iptables: /usr/sbin/iptables');
  });
  it('B6 -s reports source files when present', async () => {
    exec.vfs.mkdirp('/usr/src', 0o755, 0, 0);
    write('/usr/src/foo', '/* foo source */');
    expect(await run('whereis -s foo')).toBe('foo: /usr/src/foo');
  });
  it('B7 -m finds a man page laid out as manN/name.N', async () => {
    exec.vfs.mkdirp('/usr/share/man/man1', 0o755, 0, 0);
    write('/usr/share/man/man1/foo.1', '.TH FOO 1', 0o644);
    expect(await run('whereis -m foo')).toBe('foo: /usr/share/man/man1/foo.1');
  });
  it('B8 reports an empty colon line for an entirely unknown name', async () => {
    expect(await run('whereis zzznotacommand')).toBe('zzznotacommand:');
  });
});

describe('type', () => {
  it('C1 classifies a $PATH binary as a file with its path', async () => {
    expect(await run('type ls')).toBe('ls is /usr/bin/ls');
  });
  it('C2 classifies a shell builtin', async () => {
    expect(await run('type cd')).toBe('cd is a shell builtin');
  });
  it('C3 classifies a reserved word as a keyword', async () => {
    expect(await run('type if')).toBe('if is a shell keyword');
  });
  it('C4 -t prints the kind word for a builtin', async () => {
    expect(await run('type -t cd')).toBe('builtin');
  });
  it('C5 -t prints "keyword" for a reserved word', async () => {
    expect(await run('type -t while')).toBe('keyword');
  });
  it('C6 -t prints "file" for a $PATH executable', async () => {
    expect(await run('type -t ls')).toBe('file');
  });
  it('C7 reports an alias and its expansion', async () => {
    exec.aliases.define('ll', 'ls -l');
    expect(await run('type ll')).toBe("ll is aliased to `ls -l'");
    expect(await run('type -t ll')).toBe('alias');
  });
  it('C8 reports a shell function defined in the executor', async () => {
    exec.functions.set('myfn', { kind: 'simple' } as never);
    expect(await run('type myfn')).toBe('myfn is a function');
    expect(await run('type -t myfn')).toBe('function');
  });
  it('C9 -a lists every interpretation in precedence order', async () => {
    const lines = (await run('type -a echo')).split('\n');
    expect(lines[0]).toBe('echo is a shell builtin');
    expect(lines.some(l => l === 'echo is /usr/bin/echo')).toBe(true);
  });
  it('C10 -p prints the path only when the name would run as a file', async () => {
    expect(await run('type -p ls')).toBe('/usr/bin/ls');
    expect(await run('type -p cd')).toBe('');
  });
  it('C11 -P forces a $PATH lookup and prints the path', async () => {
    expect(await run('type -P echo')).toBe('/usr/bin/echo');
  });
  it('C12 reports "not found" and exits 1 for an unknown name', async () => {
    expect(await run('type zzznotacommand || echo MISS')).toContain('MISS');
  });
  it('C13 handles several names in one invocation', async () => {
    const out = (await run('type cd if ls')).split('\n');
    expect(out[0]).toBe('cd is a shell builtin');
    expect(out[1]).toBe('if is a shell keyword');
    expect(out[2]).toBe('ls is /usr/bin/ls');
  });
  it('C14 alias wins over a builtin of the same name', async () => {
    exec.aliases.define('echo', 'echo --');
    expect(await run('type echo')).toBe("echo is aliased to `echo --'");
  });
});
