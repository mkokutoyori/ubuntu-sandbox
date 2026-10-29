/*
 * Windows `ping` with an option it does not have: `ping -zorglub 127.0.0.1`
 * ignored the option and pinged. Windows prints `Bad option -zorglub.`
 * followed by the usage and sends nothing.
 *
 * Measured before the change: 3 of the 6 cases fall (an unknown option before
 * the target, after it, and a bare `-`-led word); the 3 witnesses (plain
 * ping, `-n 1`, `-t` limited by the simulator) pass either way. Wording from
 * memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new WindowsPC('windows-pc', 'WIN1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('ping options', () => {
  it.each(['ping 127.0.0.1', 'ping -n 1 127.0.0.1', 'ping -l 64 -n 1 127.0.0.1'])('witness: `%s` pings', async (line) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain('Pinging 127.0.0.1');
    expect(output).not.toContain('Bad option');
  });

  it.each([
    ['ping -zorglub 127.0.0.1', '-zorglub'],
    ['ping 127.0.0.1 -zorglub', '-zorglub'],
    ['ping -n 1 -q 127.0.0.1', '-q'],
  ])('`%s` is refused', async (line, option) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain(`Bad option ${option}.`);
    expect(output).toContain('Usage: ping');
    expect(output).not.toContain('Pinging');
  });
});
