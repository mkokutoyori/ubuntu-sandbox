/*
 * FortiOS `get` on a singleton configuration object (`get system dns`, `get
 * system ntp`, `get system ha status`) took a trailing word as a table key
 * and printed the object anyway, so `get system dns zorglub` answered like
 * `get system dns`. FortiOS answers `command parse error before 'zorglub'`.
 *
 * Measured before the change: 3 of the 7 cases fall (the three trailing-word
 * forms); the 4 witnesses (the bare forms, a table listing, and `get system
 * ha status`, a known view continuation that must keep working) pass either
 * way. Wording from the
 * product's own messages already in FortiMessages, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';

async function shell(): Promise<(c: string) => Promise<string>> {
  const fw = new FortiGate('firewall-fortinet', 'FG1', 0, 0);
  fw.powerOn();
  return (c) => fw.executeCommand(c);
}

describe('get on a singleton', () => {
  it.each(['get system dns', 'get system ntp', 'get system interface', 'get system ha status'])('witness: `%s`', async (line) => {
    expect(await (await shell())(line)).not.toContain('parse error');
  });

  it.each(['get system dns zorglub', 'get system ntp zorglub', 'get system ha status zorglub'])(
    '`%s` is refused', async (line) => {
      expect(await (await shell())(line)).toContain("command parse error before 'zorglub'");
    });
});
