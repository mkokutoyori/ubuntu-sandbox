/*
 * nl accepted -w, -s, -n, -v, -i, -l, -h, -f, -d and -p and ignored them:
 * `nl -w3 -s: f` printed the default layout. They are now evaluated (GNU
 * coreutils semantics: styles a/t/n/pBRE, formats ln/rn/rz, logical-page
 * delimiters \:\:\: \:\: \:, restart of numbering per page unless -p, -l joining
 * blank lines). The unnumbered-line padding and the diagnostics wording come
 * from memory of coreutils nl.c, not from a fetched page.
 *
 * Measured before the change: 14 cases, 11 fall (every option that changes the
 * output); the 3 witnesses (default layout, `-b a`, `-b t`) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function nl(args: string, text = 'a\\n\\nb\\nc\\n'): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(`printf '${text}' > /tmp/f`);
  return machine.executeCommand(`nl ${args} /tmp/f`);
}

describe('witnesses', () => {
  it('default layout', async () => { expect(await nl('')).toBe('     1\ta\n\n     2\tb\n     3\tc'); });
  it('-b a numbers blank lines', async () => { expect(await nl('-b a')).toBe('     1\ta\n     2\t\n     3\tb\n     4\tc'); });
  it('-b t is the default', async () => { expect(await nl('-b t')).toBe('     1\ta\n\n     2\tb\n     3\tc'); });
});

describe('options are evaluated', () => {
  it('-w and -s', async () => { expect(await nl('-w3 -s:')).toBe('  1:a\n\n  2:b\n  3:c'); });
  it('-n ln', async () => { expect(await nl('-n ln -w3')).toBe('1  \ta\n\n2  \tb\n3  \tc'); });
  it('-n rz', async () => { expect(await nl('-n rz -w3')).toBe('001\ta\n\n002\tb\n003\tc'); });
  it('-v and -i', async () => { expect(await nl('-v 10 -i 5')).toBe('    10\ta\n\n    15\tb\n    20\tc'); });
  it('-b n numbers nothing', async () => { expect(await nl('-b n')).toBe('       a\n\n       b\n       c'); });
  it('-b pBRE numbers matching lines only', async () => { expect(await nl('-b pb')).toBe('       a\n\n     1\tb\n       c'); });
  it('-l 2 numbers every second blank line', async () => {
    expect(await nl('-b a -l 2', 'a\\n\\n\\n\\nb\\n')).toBe('     1\ta\n\n     2\t\n\n     3\tb');
  });
  it('sections restart numbering unless -p', async () => {
    const text = 'a\\n\\\\:\\\\:\\\\:\\nb\\n';
    expect(await nl('-h a', text)).toBe('     1\ta\n\n     1\tb');
    expect(await nl('-h a -p', text)).toBe('     1\ta\n\n     2\tb');
  });
  it('a bad format is refused', async () => { expect(await nl('-n zz')).toContain("nl: invalid line numbering format: 'zz'"); });
  it('a bad width is refused', async () => { expect(await nl('-w 0')).toContain("nl: invalid line number field width: '0'"); });
  it('a bad style is refused', async () => { expect(await nl('-b q')).toContain("nl: invalid body numbering style: 'q'"); });
});
