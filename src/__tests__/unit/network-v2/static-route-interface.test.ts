import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('static route to an exit interface (Null0)', () => {
  it('creates and removes a Null0 discard route', async () => {
    const r = new CiscoRouter('R', 0, 0);
    await run(r, ['enable', 'configure terminal']);

    expect(await r.executeCommand('ip route 192.0.2.0 255.255.255.0 Null0')).not.toContain('% Invalid');
    expect(await r.executeCommand('do show ip route static')).toContain('192.0.2.0');

    expect(await r.executeCommand('no ip route 192.0.2.0 255.255.255.0 Null0')).not.toContain('% Invalid');
    expect(await r.executeCommand('do show ip route static')).not.toContain('192.0.2.0');
  });
});
