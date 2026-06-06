import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('Cisco DHCP CLI gaps', () => {
  it('no ip dhcp pool removes the pool; clear conflict and binding filter work', async () => {
    const r = new CiscoRouter('R', 0, 0);
    await run(r, ['enable', 'configure terminal',
      'ip dhcp pool LAN', 'network 10.1.1.0 255.255.255.0', 'default-router 10.1.1.1', 'exit', 'end']);
    expect(await r.executeCommand('show ip dhcp pool')).toContain('LAN');

    expect(await r.executeCommand('clear ip dhcp conflict *')).not.toContain('% Invalid');
    expect(await r.executeCommand('show ip dhcp binding 10.1.1.1')).not.toContain('% Invalid');

    await run(r, ['configure terminal', 'no ip dhcp pool LAN', 'end']);
    expect(await r.executeCommand('show ip dhcp pool')).not.toContain('LAN');
  });
});
