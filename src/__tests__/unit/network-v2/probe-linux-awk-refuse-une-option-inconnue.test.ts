/*
 * awk ignored any option placed before the program: `awk --zorglub '{print}'`
 * and `awk -Z ...` ran as if nothing had been typed. The default awk of Ubuntu
 * is mawk, which answers `awk: not an option: <word>` (status 2) and, for an
 * option missing its operand, `awk: option -F lacks argument` (status 2).
 * Every line below was compared with the real mawk 1.3.4 of the dev
 * container (same text, same status). Options after the program are
 * operands for mawk, so `awk 'BEGIN{print 1}' -z` still runs.
 *
 * Gap kept in TODO.md: `-W version` prints nothing here, the real binary
 * prints its banner.
 *
 * Measured with `git stash`: 8 cases, 5 fall before the change (every
 * refusal: two unknown options and three missing operands); the 3
 * witnesses (-F -v, --, option after the program) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('awk refuses what mawk refuses', () => {
  it.each([
    ["awk --zorglub '{print}'", 'awk: not an option: --zorglub\n2'],
    ["awk -Z '{print}'", 'awk: not an option: -Z\n2'],
    ['awk -F', 'awk: option -F lacks argument\n2'],
    ['awk -v', 'awk: option -v lacks argument\n2'],
    ['awk -f', 'awk: option -f lacks argument\n2'],
  ])('`%s`', async (line, expected) => {
    expect(await pc().executeCommand(`${line}; echo $?`)).toBe(expected);
  });
});

describe('witness: valid forms still run', () => {
  it('-F and -v', async () => {
    expect(await pc().executeCommand("awk -F: -v x=1 'BEGIN{print x}'")).toBe('1');
  });
  it('-- ends the options', async () => {
    expect(await pc().executeCommand("awk -- 'BEGIN{print 1}'")).toBe('1');
  });
  it('an option after the program is an operand', async () => {
    expect(await pc().executeCommand("awk 'BEGIN{print 1}' -z")).toBe('1');
  });
});
