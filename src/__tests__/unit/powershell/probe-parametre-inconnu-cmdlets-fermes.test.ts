/*
 * A cmdlet whose parameter list is closed (ICmdlet.closedParameterSet) refuses a
 * name it does not have, as Windows PowerShell does: `Get-Date -Zorglub` ran and
 * printed the date. Opted in so far: Get-Date, Get-Location, Get-Service. The
 * global refusal was tried first and backed out (11 reds, incomplete lists; see
 * TODO.md), hence the opt-in.
 *
 * Measured before the change: 6 cases, 3 fall (the refusals of the three
 * cmdlets); the 3 witnesses (valid parameter, unambiguous prefix, cmdlet not
 * opted in) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function run(line: string): Promise<string> {
  const shell = PowerShellSubShell.create(new WindowsPC('windows-pc', 'WIN-P')).subShell;
  return (await shell.processLine(line)).output.join('\n');
}

describe('a closed parameter set refuses an unknown name', () => {
  it.each([
    ['Get-Date', 'Zorglub'],
    ['Get-Location', 'Zorglub'],
    ['Get-Service', 'Zorglub'],
  ])('%s -%s', async (cmdlet, parameter) => {
    expect(await run(`${cmdlet} -${parameter}`)).toContain(`A parameter cannot be found that matches parameter name '${parameter}'.`);
  });
});

describe('witnesses', () => {
  it('a valid parameter is accepted', async () => {
    expect(await run('Get-Date -Format yyyy')).toMatch(/^\d{4}$/m);
  });
  it('an unambiguous prefix is accepted', async () => {
    expect(await run('Get-Service -Dis "*"')).not.toContain('A parameter cannot be found');
  });
  it('a cmdlet that is not opted in keeps its behaviour', async () => {
    expect(await run('Get-Random -Zorglub')).not.toContain('A parameter cannot be found');
  });
});
