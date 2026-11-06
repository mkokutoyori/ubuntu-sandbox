/*
 * Reference: the real PowerShell source (github.com/PowerShell/PowerShell, commit 1aac7f5e), src/Microsoft.PowerShell.Commands.Management/commands/management/TestConnectionCommand.cs and
 * TestConnectionResources.resx. In PowerShell 7: Source is Dns.GetHostName() (the machine NAME, not an address); the object is PingStatus {Ping, Source, Destination, Address (null unless
 * Success), DisplayAddress ('*' unless Success), Latency, Status (IPStatus: Success, TimedOut...), BufferSize}; a name that does not resolve is a non-terminating error "Testing connection
 * to computer '<name>' failed: Cannot resolve the target name." (id TestConnectionException, category ResourceUnavailable) unless -Quiet, which answers False; -Quiet answers True only if
 * every ping succeeded; -TcpPort answers a single [bool] (or TcpPortStatus objects with -Detailed) and Count defaults to 1 for it; -Traceroute writes TraceStatus rows (three per hop) and
 * a bare False for a name that does not resolve; -IPv6 on a target with no IPv6 address is 'Target IPv4/IPv6 address absent.'. The simulator answered every session with Windows
 * PowerShell 5.1's Win32_PingStatus shape (Source = IP, IPV4Address, 'Time(ms)', Status 'Failure'), ran an ICMP ping for -TcpPort and -Traceroute, and gave no error for an unknown name.
 * The 5.1 shape is kept for powershell.exe (the Microsoft documentation, not the source, governs it); the new parameters are core-only.
 * Limits stated: the table view of the real format file (headers 'Latency(ms)', 'BufferSize(B)') is not reproduced; -ResolveDestination, -TimeoutSeconds, -BufferSize, -MaxHops are not evaluated.
 *
 * Measured against the commit before (worktree): 6 of the 9 cases fall; the 3 that pass either way are the two WITNESSES (the 5.1 session keeps its shape; a resolvable name answers Success in both) and the -Quiet case on an unknown name (the base already answered False: non-regression).
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

async function pc() {
  await buildDnsAgenceBancaire();
  return [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-GUICHET1') as unknown as Shell;
}

const KNOWN = 'web.banquehorizon.com';
const UNKNOWN = 'nobody.banquehorizon.com';
const core = (code: string) => `pwsh -NoProfile -Command "${code}"`;
const windows = (code: string) => `powershell -NoProfile -Command "${code}"`;

describe('Test-Connection in PowerShell 7 (real PowerShell source)', () => {
  it('WITNESS 5.1 keeps the Win32_PingStatus shape', async () => {
    expect(await (await pc()).executeCommand(windows(`Test-Connection ${KNOWN} -Count 1`))).toContain('IPV4Address');
  });

  it('WITNESS a resolvable name succeeds in 7', async () => {
    expect(await (await pc()).executeCommand(core(`(Test-Connection ${KNOWN} -Count 1).Status`))).toContain('Success');
  });

  it('Source is the machine name, not an address', async () => {
    expect(await (await pc()).executeCommand(core(`(Test-Connection ${KNOWN} -Count 1).Source`))).toContain('PC-GUICHET1');
  });

  it('the object is a PingStatus: Ping, Address, Latency, BufferSize', async () => {
    const out = await (await pc()).executeCommand(core(`$r = Test-Connection ${KNOWN} -Count 2; $r.Count; $r[1].Ping; $r[0].Address; $r[0].BufferSize`));
    expect(out.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['2', '2', '203.0.113.20', '32']);
  });

  it('a name that does not resolve is the documented error', async () => {
    const out = await (await pc()).executeCommand(core(`Test-Connection ${UNKNOWN} -Count 1`));
    expect(out).toContain(`Testing connection to computer '${UNKNOWN}' failed: Cannot resolve the target name.`);
  });

  it('-Quiet on a name that does not resolve answers False and no error', async () => {
    const out = await (await pc()).executeCommand(core(`Test-Connection ${UNKNOWN} -Count 1 -Quiet`));
    expect(out.trim()).toBe('False');
  });

  it('-TcpPort answers a single boolean', async () => {
    expect((await (await pc()).executeCommand(core(`Test-Connection ${KNOWN} -TcpPort 80`))).trim()).toBe('True');
  });

  it('-TcpPort -Detailed answers TcpPortStatus with Connected and Port', async () => {
    const out = await (await pc()).executeCommand(core(`$r = Test-Connection ${KNOWN} -TcpPort 80 -Detailed; $r.Connected; $r.Port; $r.Target`));
    expect(out.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['True', '80', KNOWN]);
  });

  it('-Traceroute writes three TraceStatus rows per hop', async () => {
    const out = await (await pc()).executeCommand(core(`$r = Test-Connection ${KNOWN} -Traceroute; $r.Count; $r[0].Hop`));
    const lines = out.split('\\n').flatMap((line) => line.split('\n')).map((line) => line.trim()).filter(Boolean);
    expect(Number(lines[0]) % 3).toBe(0);
    expect(lines[1]).toBe('1');
  });
});
