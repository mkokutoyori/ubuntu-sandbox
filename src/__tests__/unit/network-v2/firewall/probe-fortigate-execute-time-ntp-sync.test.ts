/*
 * Probe: `execute time` printed the clock only. The capture ntc-templates keeps for `fortinet_execute_time` (a real FortiGate) is
 *
 *   current time is: 21:05:34
 *   last ntp sync: never
 *
 * The NTP agent the unit already runs knows when it last synchronised (`lastSyncMs`, 0 until it has), so the second line is now
 * printed: `never` while no sync has happened, otherwise the moment of the sync written like `System time` of `get system status`
 * (the capture shows only `never`; the form of a real date there is not in any source here, the system-time form is the one
 * FortiOS uses for its other stamps). `execute time hh:mm:ss`, which sets the clock, is unchanged.
 * Discriminated with git stash on src/network: 2 of 3 fall before the change; the case that sets the clock passes either way.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';

describe('execute time', () => {
  it('a unit that never synchronised says so', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    expect(await fgt.executeCommand('execute time')).toMatch(/^current time is: \d{2}:\d{2}:\d{2}\nlast ntp sync: never$/);
  });

  it('a synchronised unit prints the moment of the sync', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    (fgt.getNtpAgent().getConfig() as { lastSyncMs: number }).lastSyncMs = Date.UTC(2026, 10, 9, 12, 0, 0);
    const out = await fgt.executeCommand('execute time');
    expect(out).toMatch(/\nlast ntp sync: \w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} 2026$/);
    expect(out).not.toContain('never');
  });

  it('setting the clock keeps answering with the new time', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    expect(await fgt.executeCommand('execute time 14:30:00')).toMatch(/current time is: 14:30:\d{2}/);
  });
});
