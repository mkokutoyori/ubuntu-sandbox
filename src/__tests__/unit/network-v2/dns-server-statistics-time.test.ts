/*
 * Structure — the time group of Get-DnsServerStatistics follows the clock of the machine that hosts the DNS service, on a
 * virtual clock so the figures are exact: seconds since the service started and since the statistics were last cleared,
 * the same two moments measured from the restart of the machine (the machine had been up before the service was
 * installed, so the service's age and the machine's uptime differ), and the two dates. Clearing moves the clear date and
 * the elapsed-since-clear figures, not the start of the service. Discrimination (run on the tree before the change):
 * every case falls, the cmdlet did not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

const TIME_MEMBERS = [
  'TimeElapsedSinceServerStart', 'TimeElapsedSinceLastClearedStatistics',
  'TimeElapsedSinceServerStartBetweenRestart', 'TimeElapsedSinceLastClearedStatisticsBetweenRestart',
];

async function figures(machine: WindowsServer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const member of TIME_MEMBERS) out[member] = await run(machine, `(Get-DnsServerStatistics).TimeStatistics.${member}`);
  return out;
}

async function installedAfter(secondsOfUptime: number): Promise<WindowsServer> {
  const server = new WindowsServer('WNS1');
  server.setCurrentUser('Administrator');
  clock.advance(secondsOfUptime * 1000);
  await run(server, 'Install-WindowsFeature DNS');
  return server;
}

describe('the time statistics of the DNS service', () => {
  it('count from the start of the service, and from the restart of the machine, before anything was cleared', async () => {
    const server = await installedAfter(100);
    clock.advance(30_000);
    expect(await figures(server)).toEqual({
      TimeElapsedSinceServerStart: '30',
      TimeElapsedSinceLastClearedStatistics: '30',
      TimeElapsedSinceServerStartBetweenRestart: '130',
      TimeElapsedSinceLastClearedStatisticsBetweenRestart: '100',
    });
  });

  it('restart the since-clear figures when the statistics are cleared and leave the start of the service alone', async () => {
    const server = await installedAfter(100);
    clock.advance(30_000);
    await run(server, 'Clear-DnsServerStatistics -Force');
    clock.advance(15_000);
    expect(await figures(server)).toEqual({
      TimeElapsedSinceServerStart: '45',
      TimeElapsedSinceLastClearedStatistics: '15',
      TimeElapsedSinceServerStartBetweenRestart: '145',
      TimeElapsedSinceLastClearedStatisticsBetweenRestart: '130',
    });
  });

  it('date the start of the service and the last clear', async () => {
    const server = await installedAfter(100);
    const { times: before } = server.getDnsServerRole()!.getStatistics();
    clock.advance(30_000);
    await run(server, 'Clear-DnsServerStatistics -Force');
    const { times: after } = server.getDnsServerRole()!.getStatistics();
    expect(after.serverStartedAtMs).toBe(before.serverStartedAtMs);
    expect(after.lastClearedAtMs - before.lastClearedAtMs).toBe(30_000);
    expect(await run(server, '$t = (Get-DnsServerStatistics).TimeStatistics; ($t.LastClearTime - $t.ServerStartTime).TotalSeconds')).toBe('30');
  });

  it('count again from the moment the service is restarted', async () => {
    const server = await installedAfter(100);
    clock.advance(30_000);
    await run(server, 'Stop-Service DNS');
    clock.advance(5_000);
    await run(server, 'Start-Service DNS');
    clock.advance(10_000);
    expect(await figures(server)).toEqual({
      TimeElapsedSinceServerStart: '10',
      TimeElapsedSinceLastClearedStatistics: '10',
      TimeElapsedSinceServerStartBetweenRestart: '145',
      TimeElapsedSinceLastClearedStatisticsBetweenRestart: '135',
    });
  });
});
