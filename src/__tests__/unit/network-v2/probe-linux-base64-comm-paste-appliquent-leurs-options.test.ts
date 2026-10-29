/*
 * base64, comm and paste accepted options and ignored them: `base64 -w0` and
 * `--wrap=6` still wrapped at 76 columns, `base64 -di` (clustered) encoded
 * instead of decoding, `comm --output-delimiter=:`, `--total` and `-z` printed
 * the plain three columns, `paste -z` kept newlines. They are evaluated now;
 * `comm --check-order` refuses unsorted input, the default does not check (a
 * limit taken from memory of coreutils, not from a fetched page).
 *
 * Measured before the change: 13 cases, 10 fall; the 3 witnesses (default
 * wrapping at 76, plain decode, plain comm) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(line: string): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(`printf 'hello world foo\\n' > /tmp/a; printf 'a\\nb\\nc\\n' > /tmp/b; printf 'b\\nc\\nd\\n' > /tmp/c; printf 'aGVsbG8=\\n' > /tmp/d; printf 'c\\nb\\n' > /tmp/u; head -c 100 /dev/zero | tr '\\0' 'x' > /tmp/long; printf 'a\\nb\\nc\\n' | tr '\\n' '\\0' > /tmp/z1; printf 'b\\nc\\nd\\n' | tr '\\n' '\\0' > /tmp/z2`);
  return machine.executeCommand(line);
}

describe('witnesses', () => {
  it('default wrapping at 76 columns', async () => {
    const lines = (await run('base64 /tmp/long')).split('\n');
    expect(lines[0]).toHaveLength(76);
    expect(lines).toHaveLength(2);
  });
  it('plain decode', async () => { expect(await run('base64 -d /tmp/d')).toBe('hello'); });
  it('plain comm', async () => { expect(await run('comm /tmp/b /tmp/c')).toBe('a\n\t\tb\n\t\tc\n\td'); });
});

describe('options are evaluated', () => {
  it('base64 -w0 never wraps', async () => { expect((await run('base64 -w0 /tmp/long')).includes('\n')).toBe(false); });
  it('base64 --wrap=6', async () => { expect(await run('base64 --wrap=6 /tmp/a')).toBe('aGVsbG\n8gd29y\nbGQgZm\n9vCg=='); });
  it('base64 -w4', async () => { expect((await run('base64 -w4 /tmp/a')).split('\n')[0]).toBe('aGVs'); });
  it('base64 -di clustered decodes', async () => { expect(await run('base64 -di /tmp/d')).toBe('hello'); });
  it('base64 bad wrap is refused', async () => { expect(await run('base64 -w x /tmp/a')).toContain("base64: invalid wrap size: 'x'"); });
  it('comm --output-delimiter', async () => { expect(await run('comm --output-delimiter=: /tmp/b /tmp/c')).toBe('a\n::b\n::c\n:d'); });
  it('comm --total', async () => { expect((await run('comm --total /tmp/b /tmp/c')).split('\n').pop()).toBe('1\t1\t2\ttotal'); });
  it('comm -z reads NUL-terminated records', async () => { expect(await run('comm -12 -z /tmp/z1 /tmp/z2')).toBe('b\0c'); });
  it('comm --check-order refuses unsorted input', async () => { expect(await run('comm --check-order /tmp/u /tmp/b')).toContain('comm: file 1 is not in sorted order'); });
  it('paste -z pastes NUL-terminated records', async () => { expect(await run('paste -z /tmp/z1 /tmp/z2')).toBe('a\tb\0b\tc\0c\td'); });
});
