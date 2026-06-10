import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));
const ok = (s: string) => expect(s).not.toMatch(/Invalid|Unrecognized|Error/);

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('Huawei OSPF undo negations', () => {
  it('accepts undo of interface and process/area OSPF settings', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    await run(r, ['system-view', 'interface GigabitEthernet0/0/1']);
    ok(await r.executeCommand('ospf cost 50'));
    ok(await r.executeCommand('undo ospf cost'));
    ok(await r.executeCommand('undo ospf dr-priority'));
    ok(await r.executeCommand('undo ospf network-type'));
    ok(await r.executeCommand('undo ospf authentication-mode'));
    await run(r, ['quit', 'ospf 1']);
    ok(await r.executeCommand('undo import-route direct'));
    await run(r, ['area 0']);
    ok(await r.executeCommand('abr-summary 10.2.2.0 255.255.255.0'));
    ok(await r.executeCommand('undo abr-summary 10.2.2.0 255.255.255.0'));
  });
});
