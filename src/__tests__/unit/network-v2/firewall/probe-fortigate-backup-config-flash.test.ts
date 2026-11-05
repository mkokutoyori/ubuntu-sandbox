/*
 * Probe: `execute backup config flash [<comment>]` (FortiOS CLI Reference 7.4.12 p.3739) stores a revision that
 * `execute revision list config` shows and `execute restore config flash <id>` brings back. Measured before:
 * "Command fail. Return code -61" (only the TFTP destination existed), so a change could be rolled back only
 * from a logout snapshot.
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (the revision list starts
 * empty) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const hostnameOf = async (f: FortiGate) => await f.executeCommand('get system status');

describe('execute backup config flash', () => {
  it('witness: no revision exists on a fresh unit', async () => {
    const f = new FortiGate('firewall-fortinet', 'F', 0, 0);
    expect(await f.executeCommand('execute revision list config')).not.toContain('before-change');
  });

  it('stores a revision carrying the comment', async () => {
    const f = new FortiGate('firewall-fortinet', 'F', 0, 0);
    await f.executeCommand('execute backup config flash before-change');
    expect(await f.executeCommand('execute revision list config')).toContain('before-change');
  });

  it('the revision restores the configuration it was taken from', async () => {
    const f = new FortiGate('firewall-fortinet', 'F', 0, 0);
    await f.executeCommand('config system global');
    await f.executeCommand('set hostname BEFORE');
    await f.executeCommand('end');
    await f.executeCommand('execute backup config flash snap');
    await f.executeCommand('config system global');
    await f.executeCommand('set hostname AFTER');
    await f.executeCommand('end');
    expect(await hostnameOf(f)).toContain('AFTER');
    await f.executeCommand('execute restore config flash 1');
    expect(await hostnameOf(f)).toContain('BEFORE');
  });

  it('a second backup gets the next id', async () => {
    const f = new FortiGate('firewall-fortinet', 'F', 0, 0);
    await f.executeCommand('execute backup config flash one');
    await f.executeCommand('execute backup config flash two');
    const out = await f.executeCommand('execute revision list config');
    expect(out).toContain('one');
    expect(out).toContain('two');
  });
});
