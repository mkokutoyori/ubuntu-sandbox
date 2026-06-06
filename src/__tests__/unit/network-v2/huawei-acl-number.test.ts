import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('Huawei acl number + rule id', () => {
  it("accepts 'acl number N' and 'rule <id> permit|deny'", async () => {
    const r = new HuaweiRouter('R', 0, 0);
    await run(r, ['system-view']);

    expect(await r.executeCommand('acl number 2000')).not.toMatch(/Invalid|Error/);
    expect(await r.executeCommand('rule 5 deny source 10.2.2.11 0')).not.toMatch(/Invalid|Error/);
    expect(await r.executeCommand('rule 10 permit source any')).not.toMatch(/Invalid|Error/);
    await r.executeCommand('quit');
    expect(await r.executeCommand('display acl 2000')).toMatch(/ACL 2000|Basic ACL 2000/);

    await r.executeCommand('acl number 3001');
    expect(await r.executeCommand('rule 15 deny icmp')).not.toMatch(/Invalid|Error/);
    await r.executeCommand('quit');

    await r.executeCommand('undo acl number 2000');
  });
});
