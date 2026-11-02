/*
 * Structure — a UInt32 parameter of a DNS server cmdlet that is not a number is refused where PowerShell refuses it, at
 * the binding of the parameter, with the message of the argument transformation, and the setting it was meant for is left
 * as it was. Measured first: Set-DnsServerCache -MaxKBSize abc was accepted, the value stored was not a number, and the
 * setting read back as the default, so the previous setting was lost. Discrimination (run on the tree before the change):
 * the two refusals fall; the in-range value and the out-of-range value pass either way as NON-REGRESSION.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

async function server(): Promise<WindowsServer> {
  const machine = new WindowsServer('WNS1');
  machine.setCurrentUser('Administrator');
  await run(machine, 'Install-WindowsFeature DNS');
  return machine;
}

describe('a UInt32 parameter that is not a number', () => {
  it('is refused with the message of the argument transformation and leaves the setting alone', async () => {
    const dns = await server();
    await run(dns, 'Set-DnsServerCache -MaxKBSize 4096');
    const out = await run(dns, 'Set-DnsServerCache -MaxKBSize abc');
    expect(out).toContain(`Set-DnsServerCache : Cannot process argument transformation on parameter 'MaxKBSize'. Cannot convert value "abc" to type "System.UInt32".`);
    expect(await run(dns, '(Get-DnsServerCache).MaxKBSize')).toBe('4096');
  });

  it('is refused for the other count of the same cmdlet too', async () => {
    const dns = await server();
    await run(dns, 'Set-DnsServerCache -LockingPercent 80');
    expect(await run(dns, 'Set-DnsServerCache -LockingPercent many')).toContain(`on parameter 'LockingPercent'. Cannot convert value "many"`);
    expect(await run(dns, '(Get-DnsServerCache).LockingPercent')).toBe('80');
  });

  it('NON-REGRESSION: a number inside the range is stored', async () => {
    const dns = await server();
    expect(await run(dns, 'Set-DnsServerCache -MaxKBSize 4096')).toBe('');
    expect(await run(dns, '(Get-DnsServerCache).MaxKBSize')).toBe('4096');
  });

  it('NON-REGRESSION: a number outside the range keeps its range message', async () => {
    const dns = await server();
    expect(await run(dns, 'Set-DnsServerCache -LockingPercent 150')).toContain('The 150 argument is greater than the maximum allowed range of 100.');
  });
});
