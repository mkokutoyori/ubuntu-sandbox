/*
 * Probe — `show etherchannel summary` renders the Port-channel column the
 * way IOS does: the abbreviated bundle name with its aggregate status
 * flags, `Po1(SU)` when a member is bundled, `Po1(SD)` when none is.
 *
 * Before (FortiGate battery 03, test 106): the column printed the full
 * "Port-channel1" with no status flags, and `abbreviateInterface` did not
 * know "Port-channel" so nothing shortened it.
 *
 * Authority: Cisco IOS `show etherchannel summary` — the Port-channel
 * column is "<abbrev>(<flags>)" with S = Layer2, R = Layer3, U = in use
 * (at least one bundled port), D = down; member ports carry (P) bundled,
 * (I) stand-alone, (s) suspended. Two `mode active` local ports with no
 * partner stay stand-alone, so the bundle is (SD).
 *
 * Measured before the change (git stash of src/network/devices/shells):
 * 3 of the 4 cases fail.
 * Passing either way:
 *   - "a lone group is listed with its members" is the WITNESS: the group
 *     is formed, so the format is what the other cases measure.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function group(mode: string, members: readonly string[]): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 16, 0, 0);
  sw.powerOn();
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  for (const port of members) {
    await sw.executeCommand(`interface ${port}`);
    await sw.executeCommand(`channel-group 1 mode ${mode}`);
    await sw.executeCommand('exit');
  }
  await sw.executeCommand('end');
  return sw;
}

describe('show etherchannel summary', () => {
  it('a lone group is listed with its members', async () => {
    const sw = await group('active', ['FastEthernet0/11', 'FastEthernet0/12']);
    const out = await sw.executeCommand('show etherchannel summary');
    expect(out).toContain('Number of channel-groups in use: 1');
    expect(out).toContain('Fa0/11');
    expect(out).toContain('Fa0/12');
  });

  it('the Port-channel column is the abbreviated bundle name', async () => {
    const sw = await group('active', ['FastEthernet0/11', 'FastEthernet0/12']);
    const out = await sw.executeCommand('show etherchannel summary');
    expect(out).toMatch(/^1\s+Po1\(S[UD]\)\s+LACP\s+Fa0\/11/m);
    expect(out).not.toContain('Port-channel1 ');
  });

  it('with no bundled member the aggregate is down (SD)', async () => {
    const sw = await group('active', ['FastEthernet0/11', 'FastEthernet0/12']);
    const out = await sw.executeCommand('show etherchannel summary');
    expect(out).toMatch(/Po1\(SD\)/);
  });

  it('a static "on" group whose links are up is in use (SU)', async () => {
    const a = new CiscoSwitch('switch-cisco', 'A', 16, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'B', 16, 0, 0);
    a.powerOn();
    b.powerOn();
    new Cable('l1').connect(a.getPort('FastEthernet0/11') as never, b.getPort('FastEthernet0/11') as never);
    new Cable('l2').connect(a.getPort('FastEthernet0/12') as never, b.getPort('FastEthernet0/12') as never);
    for (const sw of [a, b]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface range FastEthernet0/11 - 12');
      await sw.executeCommand('channel-group 1 mode on');
      await sw.executeCommand('end');
    }
    const out = await a.executeCommand('show etherchannel summary');
    expect(out).toMatch(/^1\s+Po1\(SU\)\s+-\s+Fa0\/1[12]\(P\)/m);
  });
});
