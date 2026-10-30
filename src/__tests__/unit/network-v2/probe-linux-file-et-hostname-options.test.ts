/*
 * file ignored every option (`file --zorglub x`, `file -b x` and `file
 * --mime-type x` all printed `x: ASCII text`) and hostname answered an
 * unknown option in its own words (`hostname: unrecognized option: --zorglub`)
 * without the usage block. Both now print the getopt line and the usage
 * block of the real binaries of the dev container (file 5.45, net-tools
 * hostname 3.x; the statuses are 1 and 255). `file -b`, `--mime-type`,
 * `-i` and `--mime` are evaluated for ASCII text, empty files, directories,
 * symlinks, special files and shell scripts; every expected string was
 * compared with the real `file`. Other mime types are not modelled.
 *
 * Measured with `git stash`: 11 cases, 9 fall before the change; the 2
 * witnesses (plain file, hostname) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('file and hostname refuse what they refuse for real', () => {
  it('file --zorglub', async () => {
    const out = await pc().executeCommand('file --zorglub; echo $?');
    expect(out.split('\n')[0]).toBe("file: unrecognized option '--zorglub'");
    expect(out.split('\n')[1]).toBe('Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]');
    expect(out.endsWith('       file [--help]\n1')).toBe(true);
  });
  it('file -Q', async () => {
    expect((await pc().executeCommand('file -Q x')).split('\n')[0]).toBe("file: invalid option -- 'Q'");
  });
  it('hostname --zorglub, status 255', async () => {
    const out = await pc().executeCommand('hostname --zorglub; echo $?');
    expect(out.split('\n')[0]).toBe("hostname: unrecognized option '--zorglub'");
    expect(out.split('\n')[1]).toBe('Usage: hostname [-b] {hostname|-F file}         set host name (from file)');
    expect(out.endsWith('\n255')).toBe(true);
  });
  it('hostname -Q', async () => {
    expect((await pc().executeCommand('hostname -Q')).split('\n')[0]).toBe("hostname: invalid option -- 'Q'");
  });
});

describe('file evaluates -b and the mime forms', () => {
  const run = async (line: string): Promise<string> => {
    const machine = pc();
    await machine.executeCommand('mkdir -p /tmp/d; : > /tmp/e; printf "hi\\n" > /tmp/t; printf "#!/bin/sh\\necho\\n" > /tmp/s.sh');
    return machine.executeCommand(line);
  };
  it('-b drops the name', async () => { expect(await run('file -b /tmp/t')).toBe('ASCII text'); });
  it('--mime-type', async () => { expect(await run('file --mime-type /tmp/t')).toBe('/tmp/t: text/plain'); });
  it('-i adds the charset', async () => { expect(await run('file -i /tmp/t')).toBe('/tmp/t: text/plain; charset=us-ascii'); });
  it('an empty file and a directory', async () => {
    expect(await run('file -b --mime-type /tmp/e /tmp/d')).toBe('inode/x-empty\ninode/directory');
  });
  it('a shell script', async () => { expect(await run('file -i /tmp/s.sh')).toBe('/tmp/s.sh: text/x-shellscript; charset=us-ascii'); });
});

describe('witness', () => {
  it('a plain file keeps its description', async () => {
    const machine = pc();
    await machine.executeCommand('printf "hi\\n" > /tmp/t');
    expect(await machine.executeCommand('file /tmp/t')).toBe('/tmp/t: ASCII text');
  });
  it('hostname prints the host name', async () => {
    expect(await pc().executeCommand('hostname')).toBe('PC1');
  });
});
