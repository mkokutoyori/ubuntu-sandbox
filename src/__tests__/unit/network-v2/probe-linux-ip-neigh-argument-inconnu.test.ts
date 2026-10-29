/*
 * `ip neigh` answered an empty table (and exit 0) to any argument it did not
 * know: `ip neigh zorglub`, `ip neigh show zorglub`, `ip neigh show dev
 * zorglub`.
 *
 * Measured before the change: 3 of the 6 cases fall; the 3 witnesses (`ip
 * neigh`, `ip neigh show`, `ip neigh show dev eth0`) pass either way.
 * iproute2 answers `Command "zorglub" is unknown, try "ip neigh help".` to an
 * unknown sub-command and `Cannot find device "zorglub"` to an absent device;
 * for an unparsable filter it prints `Error: any valid prefix is expected
 * rather than "zorglub".` - that wording is from memory, not from a fetched
 * page.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('ip neigh arguments', () => {
  it.each(['ip neigh', 'ip neigh show', 'ip neigh show dev eth0'])('witness: `%s` is accepted', async (line) => {
    expect(await pc().executeCommand(line)).not.toMatch(/unknown|Cannot find|Error/);
  });

  it.each([
    ['ip neigh zorglub', 'Command "zorglub" is unknown, try "ip neigh help".'],
    ['ip neigh show zorglub', 'any valid prefix is expected rather than "zorglub"'],
    ['ip neigh show dev zorglub', 'Cannot find device "zorglub"'],
  ])('`%s`', async (line, message) => {
    expect(await pc().executeCommand(line)).toContain(message);
  });
});
