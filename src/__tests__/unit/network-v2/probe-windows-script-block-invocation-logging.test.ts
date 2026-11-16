/**
 * Probe: EnableScriptBlockInvocationLogging turns on 4105 and 4106 around each script block.
 *
 * Reference (rule 8): PowerShell source v7.5.0, engine/runtime/CompiledScriptBlock.cs (LogScriptBlockStart / LogScriptBlockEnd): when the policy
 * ScriptBlockLogging\EnableScriptBlockInvocationLogging is true, PSEventId.ScriptBlock_Invoke_Start_Detail (0x1009 = 4105) and ScriptBlock_Invoke_Complete_Detail
 * (0x100A = 4106) are written at Verbose level with opcode Create and tasks CommandStart (0x66) and CommandStop (0x67) (PSETWTracer.cs), carrying the script
 * block id and the runspace id; the setting is independent of EnableScriptBlockLogging. The event wording is the provider manifest's (nasbench/EVTX-ETW-
 * Resources, Microsoft-Windows-PowerShell): "Started invocation of ScriptBlock ID: {id}" / "Completed invocation of ScriptBlock ID: {id}" and "Runspace ID: {id}",
 * the dump having flattened the line break, which is written as a newline.
 *
 * Measured before the change: the policy value was stored in the registry and never read, so the setting had no effect (rule 6) and neither event existed.
 *
 * Discrimination (git stash push -- src/network src/powershell): 4 of 7 cases fall on the base. Three pass either way: the WITNESS that 4104 is written with
 * script block logging alone, and the two cases that expect nothing (no setting, a value of 0), vacuous on a base that never wrote the events.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\ScriptBlockLogging';
const setting = (name: string): Promise<string> => ps(`New-Item -Path "${KEY}" -Force | Out-Null; Set-ItemProperty -Path "${KEY}" -Name ${name} -Value 1`);
const events = (id: number): Promise<string> =>
  ps(`Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=${id}} -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }`);

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('script block invocation logging', () => {
  it('WITNESS: script block logging alone writes 4104', async () => {
    await setting('EnableScriptBlockLogging');
    await ps('Write-Output marker');
    expect(await events(4104)).toContain('Write-Output marker');
  });

  it('writes nothing without the setting', async () => {
    await setting('EnableScriptBlockLogging');
    await ps('Write-Output marker');
    expect(await events(4105)).toBe('');
    expect(await events(4106)).toBe('');
  });

  it('with the setting alone, 4105 and 4106 are written and 4104 is not', async () => {
    await setting('EnableScriptBlockInvocationLogging');
    await ps('Write-Output marker');
    expect(await events(4105)).toContain('Started invocation of ScriptBlock ID:');
    expect(await events(4106)).toContain('Completed invocation of ScriptBlock ID:');
    expect(await events(4104)).toBe('');
  });

  it('4105 and 4106 share the script block id of 4104 and one runspace id', async () => {
    await setting('EnableScriptBlockLogging');
    await setting('EnableScriptBlockInvocationLogging');
    await ps('Write-Output marker');
    const id = /ScriptBlock ID: (\S+)/.exec(await events(4104))?.[1] ?? '';
    expect(id).not.toBe('');
    const started = await events(4105);
    const completed = await events(4106);
    expect(started).toContain(`ScriptBlock ID: ${id}`);
    expect(completed).toContain(`ScriptBlock ID: ${id}`);
    const runspace = /Runspace ID: (\S+)/.exec(started)?.[1] ?? '';
    expect(runspace).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed).toContain(`Runspace ID: ${runspace}`);
  });

  it('4105 is written before 4106', async () => {
    await setting('EnableScriptBlockInvocationLogging');
    await ps('Write-Output marker');
    const ids = (await ps('Get-WinEvent -FilterHashtable @{LogName="PowerShellCore/Operational"} | Sort-Object RecordId | ForEach-Object { $_.Id }'))
      .split('\n').map((l) => l.trim());
    expect(ids.indexOf('4105')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('4105')).toBeLessThan(ids.indexOf('4106'));
  });

  it('are Verbose events with the CommandStart and CommandStop tasks', async () => {
    await setting('EnableScriptBlockInvocationLogging');
    await ps('Write-Output marker');
    const field = (id: number, property: string): Promise<string> =>
      ps(`(Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=${id}})[0].${property}`);
    expect(await field(4105, 'LevelDisplayName')).toBe('Verbose');
    expect(await field(4105, 'TaskDisplayName')).toBe('CommandStart');
    expect(await field(4106, 'TaskDisplayName')).toBe('CommandStop');
    expect(await field(4106, 'OpcodeDisplayName')).toBe('Create');
  });

  it('a value of 0 leaves it off', async () => {
    await ps(`New-Item -Path "${KEY}" -Force | Out-Null; Set-ItemProperty -Path "${KEY}" -Name EnableScriptBlockInvocationLogging -Value 0`);
    await ps('Write-Output marker');
    expect(await events(4105)).toBe('');
  });
});
