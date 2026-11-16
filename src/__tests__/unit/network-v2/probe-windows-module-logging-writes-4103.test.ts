/**
 * Probe: ModuleLogging writes 4103 for the commands of the logged modules.
 *
 * References (rule 8): PowerShell source v7.5.0. ModuleCmdletBase.cs (GetModuleLoggingInformation / SetModuleLoggingInformation): the policy
 * ModuleLogging\EnableModuleLogging turns the logging on for every module whose name equals one of ModuleNames or matches it as a wildcard;
 * PipelineProcessor (engine/pipeline.cs) buffers one line per command, "CommandInvocation(<cmd>): "<cmd>"" and "ParameterBinding(<cmd>): name="<p>"; value="<v>""
 * (PipelineStrings.resx), and writes them once the pipeline ends; PSEtwLogProvider.LogPipelineExecutionDetailEvent writes PSEventId.Pipeline_Detail (0x1007 = 4103)
 * with opcode Method (0x14) and task ExecutePipeline (0x6A), the context lines being LogContextToString's (LogProvider.cs). The cmdlet-to-module table is the
 * CmdletsToExport of the module manifests of src/Modules/Windows (Management, Utility, Security, Diagnostics). The message layout (blank lines around
 * "Context:" and "User Data:") is the manifest template flattened, "{Payload}Context:{ContextInfo}User Data:{UserData}" (nasbench dump), so its whitespace is a guess.
 *
 * Measured before the change: EnableModuleLogging was stored and never read (rule 6) and 4103 did not exist.
 *
 * Positional arguments are bound to the parameter name of their position (Position attributes of the cmdlets, from documentation and memory: the C# files are not read here); a cmdlet
 * absent from the position table logs its named parameters only.
 *
 * Discrimination (git stash push -- src/network src/powershell): the three positional cases fall on the base of the positional change (3 of 12), and 9 of 12 fall on a base with no 4103 at all. Three pass either way: the cases that expect nothing (policy off,
 * module not listed, user-defined function), vacuous on a base that never wrote 4103.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\ModuleLogging';
const enable = (names: string[]): Promise<string> =>
  ps([
    `New-Item -Path "${KEY}" -Force | Out-Null`,
    `Set-ItemProperty -Path "${KEY}" -Name EnableModuleLogging -Value 1`,
    `New-Item -Path "${KEY}\\ModuleNames" -Force | Out-Null`,
    ...names.map((name) => `Set-ItemProperty -Path "${KEY}\\ModuleNames" -Name "${name}" -Value "${name}"`),
  ].join('; '));
const events = (extra = ''): Promise<string> =>
  ps(`Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=4103} -ErrorAction SilentlyContinue ${extra}`);
const messages = (): Promise<string> => events('| ForEach-Object { $_.Message }');

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('module logging', () => {
  it('writes nothing while the policy is off', async () => {
    await ps('Get-Process -Name explorer');
    expect(await messages()).toBe('');
  });

  it('writes the command invocation of a logged module', async () => {
    await enable(['*']);
    await ps('Get-Process -Name explorer');
    expect(await messages()).toContain('CommandInvocation(Get-Process): "Get-Process"');
  });

  it('writes one ParameterBinding line per bound parameter', async () => {
    await enable(['Microsoft.PowerShell.Management']);
    await ps('Get-Process -Name explorer');
    expect(await messages()).toContain('ParameterBinding(Get-Process): name="Name"; value="explorer"');
  });

  it('writes nothing for a module the policy does not list', async () => {
    await enable(['Microsoft.PowerShell.Security']);
    await ps('Get-Process -Name explorer');
    expect(await messages()).toBe('');
  });

  it('a wildcard module name matches', async () => {
    await enable(['Microsoft.PowerShell.Man*']);
    await ps('Get-Process -Name explorer');
    expect(await messages()).toContain('CommandInvocation(Get-Process)');
  });

  it('the context carries the documented lines', async () => {
    await enable(['*']);
    await ps('Get-Process -Name explorer');
    const text = await messages();
    for (const label of ['Severity = Informational', 'Host Name = ConsoleHost', 'Command Name = Get-Process', 'Command Type = Cmdlet', 'Shell ID = Microsoft.PowerShell']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/User = \S+\\Administrator/);
  });

  it('is tagged task 106, opcode 20 and level Information', async () => {
    await enable(['*']);
    await ps('Get-Process -Name explorer');
    expect(await events('| Select-Object -First 1 | ForEach-Object { "$($_.Task) $($_.Opcode) $($_.LevelDisplayName)" }')).toBe('106 20 Information');
  });

  it('one pipeline is one event', async () => {
    await enable(['*']);
    await ps('Get-Process -Name explorer | Select-Object -First 1');
    expect(await events('| Measure-Object | ForEach-Object { $_.Count }')).toBe('1');
  });

  it('writes nothing for a user-defined function', async () => {
    await enable(['*']);
    await ps('function Get-Thing { 1 }; Get-Thing');
    expect(await messages()).not.toContain('Get-Thing');
  });

  it('binds a positional argument to the name of its position', async () => {
    await enable(['*']);
    await ps('Get-Process explorer');
    expect(await messages()).toContain('ParameterBinding(Get-Process): name="Name"; value="explorer"');
  });

  it('binds several positional arguments in order', async () => {
    await enable(['*']);
    await ps('Copy-Item C:\\Windows\\win.ini C:\\Temp\\win.ini');
    const text = await messages();
    expect(text).toContain('ParameterBinding(Copy-Item): name="Path"; value="C:\\Windows\\win.ini"');
    expect(text).toContain('ParameterBinding(Copy-Item): name="Destination"; value="C:\\Temp\\win.ini"');
  });

  it('does not bind a positional argument to a parameter already given by name', async () => {
    await enable(['*']);
    await ps('Get-ChildItem -Path C:\\ *.txt');
    const text = await messages();
    expect(text).toContain('name="Path"; value="C:\\"');
    expect(text).toContain('name="Filter"; value="*.txt"');
  });
});
