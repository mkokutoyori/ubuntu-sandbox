/*
 * Windows `arp` and `tracert` skipped an option they do not have:
 * `arp -zorglub` printed the ARP table (or `No ARP Entries Found.`),
 * `tracert -zorglub 127.0.0.1` traced. Windows prints the usage for `arp`
 * and `Bad option -zorglub.` plus the usage for `tracert`.
 *
 * Measured before the change: 4 of the 9 cases fall (`arp -zorglub`, `arp
 * zorglub`, `tracert -zorglub 127.0.0.1`, `tracert 127.0.0.1 -zorglub`); the
 * 5 witnesses (`arp -a`, `arp -a 10.0.0.1`, `arp -v -a`, `tracert -d
 * 127.0.0.1`, `tracert -h 5 127.0.0.1`) pass either way. Wording
 * from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new WindowsPC('windows-pc', 'WIN1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('valid forms still work', () => {
  it.each(['arp -a', 'arp -a 10.0.0.1', 'arp -v -a', 'tracert -d 127.0.0.1', 'tracert -h 5 127.0.0.1'])(
    'witness: `%s`', async (line) => {
      const output = await pc().executeCommand(line);
      expect(output).not.toContain('Bad option');
      expect(output).not.toMatch(/Usage: (arp|tracert)|Displays and modifies/);
    });
});

describe('an unknown option is refused', () => {
  it.each(['arp -zorglub', 'arp zorglub'])('`%s` prints the arp usage', async (line) => {
    expect(await pc().executeCommand(line)).toMatch(/Displays and modifies the IP-to-Physical/);
  });

  it.each(['tracert -zorglub 127.0.0.1', 'tracert 127.0.0.1 -zorglub'])('`%s`', async (line) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain('Bad option -zorglub.');
    expect(output).toContain('Usage: tracert');
    expect(output).not.toContain('Tracing route');
  });
});
