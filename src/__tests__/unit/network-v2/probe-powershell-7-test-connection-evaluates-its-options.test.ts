/*
 * Reference: PowerShell/PowerShell TestConnectionCommand.cs (ParameterSets, ValidateRange 1..128 on MaxHops, 0..65500 on BufferSize, >=1 on TimeoutSeconds and Delay;
 * PingOptions(ttl); the reply status of the ICMP answer is the IPStatus: TtlExpired carries the address of the router that answered; a reply later than TimeoutSeconds is TimedOut;
 * -Traceroute stops at MaxHops with MaxHopsExceeded from TestConnectionResources.resx).
 * Before this change the cmdlet declared -Delay and read it nowhere, ignored -BufferSize (the echo was always 56 bytes and the object said 32), had no -TimeoutSeconds and no -MaxHops
 * (the cmdlet accepted any parameter without refusing it), and answered only Success or TimedOut.
 *
 * Measured against the commit before (git stash of src/network and src/powershell): see the commit message for the count; the cases that pass either way are named there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PathClock } from '@/network/core/time/PathClock';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import type { Equipment } from '@/network';

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
  const device = [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-GUICHET1') as Equipment;
  const echoSizes: number[] = [];
  device.getBus().subscribe('host.icmp.echo-sent', (event) => { echoSizes.push((event.payload as { size: number }).size); });
  return { device, echoSizes, run: (code: string) => (device as unknown as Shell).executeCommand(`pwsh -NoProfile -Command "${code}"`) };
}

const TARGET = 'web.banquehorizon.com';

describe('Test-Connection evaluates what it accepts', () => {
  it('WITNESS a plain ping answers Success', async () => {
    const { run } = await lab();
    expect((await run(`(Test-Connection ${TARGET} -Count 1).Status`)).trim()).toBe('Success');
  });

  it('NON-REGRESSION -Count 2 sends two echoes', async () => {
    const { run, echoSizes } = await lab();
    await run(`Test-Connection ${TARGET} -Count 2 -Quiet`);
    expect(echoSizes).toHaveLength(2);
  });

  it('-MaxHops 1 expires at the first router, which answers with its address', async () => {
    const { run } = await lab();
    const out = await run(`$r = Test-Connection ${TARGET} -Count 1 -MaxHops 1; ($r.Status, $r.Address) -join ';'`);
    expect(out.trim()).toBe('TtlExpired;10.20.10.1');
  });

  it('-Ttl and -TimeToLive are the same parameter', async () => {
    const { run } = await lab();
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -Ttl 1).Status`)).trim()).toBe('TtlExpired');
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -TimeToLive 1).Status`)).trim()).toBe('TtlExpired');
  });

  it('-BufferSize sets the size of the echo on the wire and in the object', async () => {
    const { run, echoSizes } = await lab();
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -BufferSize 100).BufferSize`)).trim()).toBe('100');
    expect(echoSizes).toContain(108);
  });

  it('-Delay waits between the echoes on the path clock', async () => {
    const { run } = await lab();
    const before = PathClock.now();
    await run(`Test-Connection ${TARGET} -Count 2 -Delay 3 -Quiet`);
    expect(PathClock.now() - before).toBeGreaterThanOrEqual(3000);
  });

  it('-TimeoutSeconds turns a reply that comes later into TimedOut', async () => {
    const { run, device } = await lab();
    for (const port of device.getPorts()) {
      const cable = port.getCable();
      if (cable) cable.setEgressNetem(port, { lossRate: 0, delayMs: 2000, ecn: false });
    }
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -TimeoutSeconds 1).Status`)).trim()).toBe('TimedOut');
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -TimeoutSeconds 5).Status`)).trim()).toBe('Success');
  });

  it('-DontFragment with an echo larger than the path MTU answers PacketTooBig, one that fits answers Success', async () => {
    const { run } = await lab();
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -BufferSize 1500 -DontFragment).Status`)).trim()).toBe('PacketTooBig');
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -BufferSize 1400 -DontFragment).Status`)).trim()).toBe('Success');
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -BufferSize 1500).Status`)).trim()).not.toBe('PacketTooBig');
    expect((await run(`(Test-Connection ${TARGET} -Count 1 -BufferSize 100 -DontFragment).Status`)).trim()).toBe('Success');
  });

  it('-Quiet followed by the target still reads -Quiet as a switch', async () => {
    const { run } = await lab();
    expect((await run(`Test-Connection -Quiet ${TARGET} -Count 1`)).trim()).toBe('True');
  });

  it.each([
    ['-MaxHops 0', 'MaxHops', 'The 0 argument is less than the minimum allowed range of 1.'],
    ['-MaxHops 129', 'MaxHops', 'The 129 argument is greater than the maximum allowed range of 128.'],
    ['-BufferSize 70000', 'BufferSize', 'The 70000 argument is greater than the maximum allowed range of 65500.'],
    ['-TimeoutSeconds 0', 'TimeoutSeconds', 'The argument "0" cannot be validated because its value is not greater than zero.'],
    ['-Delay 0', 'Delay', 'The argument "0" cannot be validated because its value is not greater than zero.'],
    ['-Count 0', 'Count', 'The argument "0" cannot be validated because its value is not greater than zero.'],
  ])('%s is refused by the range of the parameter', async (option, parameter, message) => {
    const { run } = await lab();
    const out = await run(`Test-Connection ${TARGET} -Count 1 ${option}`);
    expect(out).toContain(`Cannot validate argument on parameter '${parameter}'. ${message}`);
  });

  it('-Traceroute -MaxHops 1 stops at the first hop and says the destination is farther', async () => {
    const { run } = await lab();
    const out = await run(`Test-Connection ${TARGET} -Traceroute -MaxHops 1`);
    expect(out).toContain(`Cannot complete traceroute to destination '${TARGET}': Number of hops required to reach host exceeds MaxHops (1).`);
    expect(out).not.toContain('Hop           : 2');
  });
});
