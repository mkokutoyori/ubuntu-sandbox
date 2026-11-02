/*
 * Structure — an event channel can be defined disabled, as an installed provider manifest defines its analytic channels:
 * the channel exists, wevtutil reports it as not enabled, an event written to it is not recorded until it is enabled, and
 * defining it again changes nothing about the one already there. wevtutil reports the type of a channel from the last part
 * of its name, and a channel called Analytical is of the type Analytic. Discrimination (run on the tree before the change):
 * 4 of 9 cases fall, the three that define a disabled channel and the one that reports Analytical; the other five pass
 * either way as NON-REGRESSION (a channel defined enabled, and the types Analytic, Operational, Debug and Admin).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PSEventLogProvider } from '@/network/devices/windows/PSEventLogProvider';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

describe('defining a channel', () => {
  it('creates it enabled by default', () => {
    const provider = new PSEventLogProvider();
    provider.newEventLog('Contoso/Operational', 'Contoso');
    expect(provider.getLogStatus('Contoso/Operational')?.enabled).toBe(true);
    provider.writeEventLog('Contoso/Operational', 'Contoso', 1, 'Information', 'recorded');
    expect(provider.getLogStatus('Contoso/Operational')?.numberOfLogRecords).toBe(1);
  });

  it('creates it disabled when asked, and drops what is written to it', () => {
    const provider = new PSEventLogProvider();
    provider.newEventLog('Contoso/Analytical', 'Contoso', false);
    expect(provider.getLogStatus('Contoso/Analytical')?.enabled).toBe(false);
    expect(provider.writeEventLog('Contoso/Analytical', 'Contoso', 281, 'Information', 'dropped')).toBe('');
    expect(provider.getLogStatus('Contoso/Analytical')?.numberOfLogRecords).toBe(0);
  });

  it('records again once the channel is enabled', () => {
    const provider = new PSEventLogProvider();
    provider.newEventLog('Contoso/Analytical', 'Contoso', false);
    provider.writeEventLog('Contoso/Analytical', 'Contoso', 281, 'Information', 'before');
    expect(provider.getLogStatus('Contoso/Analytical')?.numberOfLogRecords).toBe(0);
    provider.setLogConfig('Contoso/Analytical', { enabled: true });
    provider.writeEventLog('Contoso/Analytical', 'Contoso', 281, 'Information', 'after');
    expect(provider.getLogStatus('Contoso/Analytical')?.numberOfLogRecords).toBe(1);
  });

  it('leaves a channel that exists alone, whatever the second definition says', () => {
    const provider = new PSEventLogProvider();
    provider.newEventLog('Contoso/Analytical', 'Contoso', false);
    expect(provider.getLogStatus('Contoso/Analytical')?.enabled).toBe(false);
    provider.newEventLog('Contoso/Analytical', 'Contoso', true);
    expect(provider.getLogStatus('Contoso/Analytical')?.enabled).toBe(false);
    provider.setLogConfig('Contoso/Analytical', { enabled: true });
    provider.newEventLog('Contoso/Analytical', 'Contoso', false);
    expect(provider.getLogStatus('Contoso/Analytical')?.enabled).toBe(true);
  });
});

describe('the type wevtutil reports', () => {
  async function typeOf(name: string): Promise<string> {
    const machine = new WindowsServer('WNS1');
    machine.setCurrentUser('Administrator');
    machine.eventLog.newEventLog(name, 'Contoso');
    const out = await run(machine, `wevtutil gl ${name}`);
    return out.split('\n').find(line => line.startsWith('type:')) ?? '';
  }

  it.each([
    ['Contoso/Analytical', 'type: Analytic'],
    ['Contoso/Analytic', 'type: Analytic'],
    ['Contoso/Operational', 'type: Operational'],
    ['Contoso/Debug', 'type: Debug'],
    ['Contoso/Admin', 'type: Admin'],
  ])('is right for %s', async (name, expected) => {
    expect(await typeOf(name)).toBe(expected);
  });
});
