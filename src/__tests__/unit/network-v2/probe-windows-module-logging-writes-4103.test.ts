/**
 * Probe: ModuleLogging writes 4103 for the commands of the logged modules.
 *
 * References (rule 8): PowerShell source v7.5.0. ModuleCmdletBase.cs (GetModuleLoggingInformation / SetModuleLoggingInformation): the policy
 * ModuleLogging\EnableModuleLogging turns the logging on for every module whose name equals one of ModuleNames or matches it as a wildcard;
 * PipelineProcessor (engine/pipeline.cs) buffers one line per command, "CommandInvocation(<cmd>): "<cmd>"" and "ParameterBinding(<cmd>): name="<p>"; value="<v>""
 * (PipelineStrings.resx), and writes them once the pipeline ends; PSEtwLogProvider.LogPipelineExecutionDetailEvent writes PSEventId.Pipeline_Detail (0x1007 = 4103)
 * with opcode Method (0x14) and task ExecutePipeline (0x6A), the context lines being LogContextToString's (LogProvider.cs). The cmdlet-to-module table is the
 * CmdletsToExport of the module manifests of src/Modules/Windows (Management, Utility, Security, Diagnostics), and for the other modules the cmdlet lists of their Microsoft Learn
 * module pages (NetTCPIP, NetSecurity, NetAdapter, SmbShare, DnsClient, ScheduledTasks, ActiveDirectory, DhcpServer, DnsServer, ServerManager, Storage, NetConnection, BitsTransfer,
 * LocalAccounts, Core, Host, Archive, iSCSI, NFS, SmbWitness, Hyper-V, Defender, BitLocker, NetLbfo, PrintManagement, Dism, Appx, WindowsUpdateProvider, ConfigCI, DFSR, DFSN,
 * FailoverClusters, NetworkController, NetNat, NetSwitchTeam, NetQos, PKI). The message layout (blank lines around
 * "Context:" and "User Data:") is the manifest template flattened, "{Payload}Context:{ContextInfo}User Data:{UserData}" (nasbench dump), so its whitespace is a guess.
 *
 * Measured before the change: EnableModuleLogging was stored and never read (rule 6) and 4103 did not exist.
 *
 * Positional arguments are bound to the parameter name of their position (Position attributes of the cmdlets, from documentation and memory: the C# files are not read here); a cmdlet
 * absent from the position table logs its named parameters only.
 *
 * VpnClient, CimCmdlets, International and Microsoft.WSMan.Management come from their Learn pages as well; the VpnClient case falls on the previous commit (1 of 22).
 * Pipeline cases: the logging case falls on the previous commit (1 of 19); the by-name case passes either way (vacuous there). By-property-name binding reads the "Value from pipeline
 * by property name" flags of the same pages (168 cmdlets): the property-name case falls on the previous commit (1 of 21), the absent-property case passes either way.
 * Values bound from the pipeline are logged under the parameter whose "Value from pipeline" is True on the Learn page (one parameter only; a cmdlet with several is skipped).
 *
 * The last two cases of the positional block fall on the commit that had the hand-written table (2 of 17): Get-NetIPAddress was absent from it, and it bound Get-WinEvent's first argument to LogName
 * although the position is shared with FilterHashtable.
 *
 * Discrimination (git stash push -- src/network src/powershell): the three positional cases and the two other-module cases fall on the base of those changes (6 of 15), and 9 of 12 fall on a base with no 4103 at all. Three pass either way: the cases that expect nothing (policy off,
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

  it('logs a cmdlet of NetTCPIP when that module is listed', async () => {
    await enable(['NetTCPIP']);
    await ps('Get-NetIPAddress');
    expect(await messages()).toContain('CommandInvocation(Get-NetIPAddress): "Get-NetIPAddress"');
  });

  it('logs a cmdlet of NetSecurity and not one of NetTCPIP when only NetSecurity is listed', async () => {
    await enable(['NetSecurity']);
    await ps('Get-NetIPAddress; Get-NetFirewallRule');
    const text = await messages();
    expect(text).toContain('CommandInvocation(Get-NetFirewallRule)');
    expect(text).not.toContain('CommandInvocation(Get-NetIPAddress)');
  });

  it('logs a cmdlet of Storage when that module is listed', async () => {
    await enable(['Storage']);
    await ps('Get-Disk');
    expect(await messages()).toContain('CommandInvocation(Get-Disk): "Get-Disk"');
  });

  it('binds the positional argument of a cmdlet outside the former hand-written table', async () => {
    await enable(['*']);
    await ps('Get-NetIPAddress 127.0.0.1');
    expect(await messages()).toContain('ParameterBinding(Get-NetIPAddress): name="IPAddress"; value="127.0.0.1"');
  });

  it('binds nothing for a position shared by two parameter sets (Get-WinEvent: LogName or FilterHashtable)', async () => {
    await enable(['*']);
    await ps('Get-WinEvent System -MaxEvents 1');
    const text = await messages();
    expect(text).toContain('CommandInvocation(Get-WinEvent)');
    expect(text).not.toContain('value="System"');
  });

  it('logs a value bound from the pipeline, one line per item, under the parameter the page says takes the pipeline', async () => {
    await enable(['*']);
    await ps("'alpha','beta' | Write-Output");
    const text = await messages();
    expect(text).toContain('ParameterBinding(Write-Output): name="InputObject"; value="alpha"');
    expect(text).toContain('ParameterBinding(Write-Output): name="InputObject"; value="beta"');
  });

  it('does not log a pipeline binding for a parameter given by name', async () => {
    await enable(['*']);
    await ps("'alpha' | Write-Output -InputObject direct");
    const text = await messages();
    expect(text).toContain('value="direct"');
    expect(text).not.toContain('value="alpha"');
  });

  it('logs a value bound by property name from a piped object', async () => {
    await enable(['*']);
    await ps("[pscustomobject]@{Name='Spooler'} | Get-Service");
    expect(await messages()).toContain('ParameterBinding(Get-Service): name="Name"; value="Spooler"');
  });

  it('logs nothing for a property the object does not carry', async () => {
    await enable(['*']);
    await ps("[pscustomobject]@{Other='x'} | Get-Service");
    expect(await messages()).not.toContain('value="x"');
  });

  it('logs a cmdlet of VpnClient when that module is listed', async () => {
    await enable(['VpnClient']);
    await ps('Get-VpnConnection');
    expect(await messages()).toContain('CommandInvocation(Get-VpnConnection)');
  });
});
