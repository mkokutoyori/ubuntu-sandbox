/*
 * Reference: PowerShell/PowerShell PowerShellCore_format_ps1xml.cs (the views of PingStatus, TcpPortStatus and TraceStatus: fixed column widths, right-aligned numbers, '*' for a latency or a buffer
 * size of a timed-out echo, GroupByProperty banner) and TableWriter.cs (a header longer than its column wraps onto the next row, a value longer than its column is cut with an ellipsis, the last
 * column carries no trailing blanks); TestConnectionCommand.cs ([Parameter] sets: -Continuous does not exist, -Repeat does, and ValidateRange(Positive) on -Count).
 * Before this change the default output of Test-Connection printed the property names ("Ping : 1", "Source : ..." as a list), accepted any parameter without refusing it (-Continuous, a 5.1 name
 * that PowerShell 7 does not have, was honoured by the terminal) and the interactive stream printed the Windows PowerShell 5.1 columns (IPV4Address, Bytes, Time(ms)).
 *
 * Measured against the commit before (git stash of src/network, src/powershell and src/terminal): see the commit message for the count; the case that passes either way is the WITNESS that the lab
 * answers a ping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  await buildDnsAgenceBancaire();
  const device = [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-GUICHET1') as unknown as Shell;
  return (code: string) => device.executeCommand(`pwsh -NoProfile -Command "${code}"`);
}

const TARGET = 'web.banquehorizon.com';

describe('Test-Connection prints the table views of PowerShell 7', () => {
  it('WITNESS the lab answers a ping', async () => {
    const run = await lab();
    expect((await run(`Test-Connection ${TARGET} -Count 1 -Quiet`)).trim()).toBe('True');
  });

  it('a ping is grouped by destination, with the wrapped headers and one row per echo', async () => {
    const run = await lab();
    const lines = (await run(`Test-Connection ${TARGET} -Count 2`)).split('\n');
    expect(lines).toEqual([
      '',
      `   Destination: ${TARGET}`,
      '',
      'Ping Source           Address                   Latency BufferSize Status',
      '                                                   (ms)        (B)',
      '---- ------           -------                   ------- ---------- ------',
      expect.stringMatching(/^   1 PC-GUICHET1 +203\.0\.113\.20 +\d+ +32 Success$/),
      expect.stringMatching(/^   2 PC-GUICHET1 +203\.0\.113\.20 +\d+ +32 Success$/),
    ]);
  });

  it('a timed-out echo shows * for its latency and its buffer size', async () => {
    const run = await lab();
    const out = await run('Test-Connection 10.20.10.99 -Count 1');
    expect(out).toMatch(/^ {3}1 PC-GUICHET1 +\* +\* +\* +TimedOut$/m);
  });

  it('a status longer than its column is cut with an ellipsis, and the router that answered is the address', async () => {
    const run = await lab();
    const out = await run('Test-Connection 10.255.255.9 -Count 1');
    expect(out).toMatch(/^ {3}1 PC-GUICHET1 +192\.0\.2\.1 +0 +32 DestinationNetw\u2026$/m);
  });

  it('-TcpPort -Detailed prints the TcpPortStatus view grouped by target', async () => {
    const run = await lab();
    const out = await run(`Test-Connection ${TARGET} -TcpPort 80 -Count 1 -Detailed`);
    expect(out).toContain(`   Target: ${TARGET}`);
    expect(out).toContain('Id Source           Address                      Port Latency Connected  Status');
  });

  it('-Traceroute prints the TraceStatus view grouped by target', async () => {
    const run = await lab();
    const out = await run(`Test-Connection ${TARGET} -Traceroute`);
    expect(out).toContain(`   Target: ${TARGET}`);
    expect(out).toContain('Hop Hostname                  Ping Latency Status           Source       TargetAddress');
  });

  it('refuses -Continuous, which is not a parameter of PowerShell 7', async () => {
    const run = await lab();
    expect(await run(`Test-Connection ${TARGET} -Continuous`)).toContain("A parameter cannot be found that matches parameter name 'Continuous'.");
  });

  it('says that -Repeat needs an interactive terminal outside of one', async () => {
    const run = await lab();
    expect(await run(`Test-Connection ${TARGET} -Repeat`)).toContain('-Repeat sends echoes until it is stopped');
  });
});
