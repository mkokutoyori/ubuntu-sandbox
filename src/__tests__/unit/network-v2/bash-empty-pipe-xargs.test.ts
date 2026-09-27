/**
 * Probe — an empty pipe is still a pipe, and xargs is GNU findutils' xargs.
 *
 * Measured on a LinuxPC before the fix: `true | wc -l` printed nothing
 * (the stage after an empty producer received no stdin at all and read
 * no file), `true | base64 | wc -c` printed nothing once a network-registry
 * command sat in the line (the async dispatcher dropped the stage's stdin),
 * `printf '' | md5sum` hashed nothing, and `xargs` was the old stub that
 * ignored -n/-L/-I/-0/-r/-t and never reported 123/127.
 *
 * Authority: GNU findutils xargs.c (master) for option parsing, input
 * splitting (quotes, -0, -I line mode), the "unmatched single quote"
 * diagnostic and exit statuses 123/124/126/127; GNU coreutils for the
 * digests of empty input (RFC 1321 / FIPS 180-4 empty-message values).
 *
 * Discrimination (`git stash` of the sources): 14 of 16 cases fail before.
 * Two pass on both trees: the witness `echo hi | wc -c`, which proves the
 * lab and the non-empty pipe path are sound, and `xargs -r` on empty input,
 * where the old stub's silence happened to be the right answer.
 */
import { describe, expect, it } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function run(command: string): Promise<string> {
  const pc = new LinuxPC('PC1', 0, 0);
  return pc.executeCommand(command);
}

describe('empty pipe', () => {
  it('witness: a non-empty pipe counts its bytes', async () => {
    expect(await run('echo hi | wc -c')).toBe('3');
  });

  it('wc reads the empty pipe and counts zero lines', async () => {
    expect(await run('true | wc -l')).toBe('0');
  });

  it('wc after an empty network-registry stage still reads the pipe', async () => {
    expect(await run('true | base64 | wc -c; echo after')).toBe('0\nafter');
  });

  it('md5sum of an empty pipe is the digest of the empty message', async () => {
    expect(await run("printf '' | md5sum")).toBe('d41d8cd98f00b204e9800998ecf8427e  -');
  });

  it('sha256sum of an empty pipe is the digest of the empty message', async () => {
    expect(await run('true | sha256sum'))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  -');
  });
});

describe('xargs', () => {
  it('runs the command once on empty input', async () => {
    expect(await run('true | xargs echo hi')).toBe('hi');
  });

  it('-r does not run the command on empty input', async () => {
    expect(await run('true | xargs -r echo hi; echo "rc=$?"')).toBe('rc=0');
  });

  it('-n batches arguments', async () => {
    expect(await run("printf 'a b c d\\n' | xargs -n 2 echo")).toBe('a b\nc d');
  });

  it('-L batches lines', async () => {
    expect(await run("printf 'x y\\nz\\n' | xargs -L 1 echo")).toBe('x y\nz');
  });

  it('-I replaces per input line', async () => {
    expect(await run("printf 'a\\nb\\n' | xargs -I X echo [X]")).toBe('[a]\n[b]');
  });

  it('-0 splits on NUL', async () => {
    expect(await run("printf 'a\\0b\\0' | xargs -0 echo")).toBe('a b');
  });

  it('-t traces the command line to stderr', async () => {
    const out = await run('echo a b | xargs -t echo 2>/dev/null');
    expect(out).toBe('a b');
    expect(await run('echo a b | xargs -t echo 2>&1 >/dev/null')).toBe('echo a b');
  });

  it('a missing command exits 127', async () => {
    expect(await run('echo a | xargs nosuchcmd; echo "rc=$?"'))
      .toBe('xargs: nosuchcmd: No such file or directory\nrc=127');
  });

  it('a failing command exits 123', async () => {
    expect(await run('echo a | xargs false; echo "rc=$?"')).toBe('rc=123');
  });

  it('-n 0 is refused with the findutils wording', async () => {
    expect(await run('echo a | xargs -n 0 echo; echo "rc=$?"'))
      .toBe("xargs: value 0 for -n option should be >= 1\nTry 'xargs --help' for more information.\nrc=1");
  });

  it('an unmatched quote aborts', async () => {
    expect(await run('echo "\'a" | xargs echo; echo "rc=$?"'))
      .toBe('xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\nrc=1');
  });
});
