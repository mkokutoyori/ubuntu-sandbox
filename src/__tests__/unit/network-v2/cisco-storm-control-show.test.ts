/*
 * Probe — `show storm-control [interface] [type]` prints the configured
 * suppression level, and accepts an interface argument.
 *
 * Before (FortiGate battery 03, test 103): `storm-control broadcast level
 * 10.00` was accepted and kept (it comes back in running-config), but
 * `show storm-control FastEthernet0/3 broadcast` answered "% Invalid input
 * detected at '^' marker." — the view had no interface place, so a learner
 * could set a threshold and never read it back on the port.
 *
 * Authority: Cisco IOS `show storm-control [interface-id] [broadcast |
 * multicast | unicast]` — a table with columns Interface, Filter State,
 * Upper, Lower, Current; percentages as "10.00%". The Current column stays
 * 0.00% here because no per-port per-type rate counter exists in the data
 * plane, which is the honest thing to show rather than an invented rate.
 *
 * Measured before the change (git stash of src/network/devices/shells):
 * 2 of the 5 cases fail — the two that pass an interface argument. The
 * bogus-argument refusal passed before only because the view rejected any
 * interface at all.
 * Passing either way:
 *   - "the level survives in running-config" is the WITNESS: the setting is
 *     stored, so the view is what the other cases measure.
 *   - "a bogus interface argument is refused" is non-regression: adding an
 *     interface place must not let "zorglub" through (rule 6).
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

async function withStorm(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/3',
    'storm-control broadcast level 10.00', 'end']) await sw.executeCommand(c);
  return sw;
}

describe('show storm-control', () => {
  it('the level survives in running-config', async () => {
    const sw = await withStorm();
    expect(await sw.executeCommand('show running-config interface FastEthernet0/3'))
      .toContain('storm-control broadcast level 10.00');
  });

  it('show storm-control lists the configured level', async () => {
    const sw = await withStorm();
    const out = await sw.executeCommand('show storm-control');
    expect(out).toMatch(/^Interface\s+Filter State/m);
    expect(out).toMatch(/^Fa0\/3\s+Forwarding\s+10\.00%/m);
  });

  it('an interface argument is accepted and filters the table', async () => {
    const sw = await withStorm();
    const out = await sw.executeCommand('show storm-control FastEthernet0/3 broadcast');
    expect(out).not.toContain('% Invalid input');
    expect(out).toMatch(/^Fa0\/3\s+Forwarding\s+10\.00%\s+10\.00%\s+0\.00%$/m);
  });

  it('an interface with no storm-control shows no row', async () => {
    const sw = await withStorm();
    const out = await sw.executeCommand('show storm-control FastEthernet0/4 broadcast');
    expect(out).not.toContain('% Invalid input');
    expect(out).not.toMatch(/^Fa0\/4\s+Forwarding/m);
  });
  it('a bogus interface argument is refused, like IOS', async () => {
    const sw = await withStorm();
    expect(await sw.executeCommand('show storm-control zorglub broadcast')).toContain('% Invalid input');
    expect(await sw.executeCommand('show storm-control 42')).toContain('% Invalid input');
  });
});
