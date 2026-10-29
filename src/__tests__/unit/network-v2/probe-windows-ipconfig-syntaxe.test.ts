/*
 * `ipconfig` with a switch or word it does not have: `ipconfig /zorglub`,
 * `ipconfig zorglub` and `ipconfig /all zorglub` all answered like the bare
 * command, so a mistyped switch looked like it had worked. Windows answers
 * `error: unrecognized or incomplete command line.` followed by the usage.
 *
 * Measured before the change: 4 of the 9 cases fall (the four refusals, `ipconfig
 * /flushdns zorglub` included). The 5 witnesses (`ipconfig`, `/all`,
 * `/flushdns`, `/release` with an adapter name, `/allcompartments /all`) pass
 * either way. Which switches take an operand is from memory of the usage text
 * the command itself prints, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new WindowsPC('windows-pc', 'WIN1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('ipconfig syntax', () => {
  it.each([
    'ipconfig', 'ipconfig /all', 'ipconfig /flushdns', 'ipconfig /release "Ethernet 0"',
    'ipconfig /allcompartments /all',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await pc().executeCommand(line)).not.toMatch(/unrecognized or incomplete/);
  });

  it.each([
    'ipconfig /zorglub', 'ipconfig zorglub', 'ipconfig /all zorglub', 'ipconfig /flushdns zorglub',
  ])('`%s` is refused', async (line) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain('error: unrecognized or incomplete command line.');
    expect(output).toContain('USAGE:');
  });
});
