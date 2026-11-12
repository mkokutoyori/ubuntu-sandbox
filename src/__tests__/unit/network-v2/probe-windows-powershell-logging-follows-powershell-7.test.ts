/**
 * Probe: Script Block Logging follows PowerShell 7, not Windows PowerShell 5.1.
 *
 * References (rule 8): about_Logging_Windows, PowerShell 7.6 (learn.microsoft.com): the event provider is PowerShellCore, the log is
 * PowerShellCore/Operational, the policy key is HKLM\Software\Policies\Microsoft\PowerShellCore\ScriptBlockLogging, and event 4104 is Level Verbose,
 * Opcode Create, Task CommandStart, Keyword Runspace. PowerShell source v7.5.0 (engine/PSConfiguration.cs): the Transcription policy sits under the
 * same PowerShellCore key; engine/remoting/common/PSETWTracer.cs: PSKeyword.Runspace = 0x1, PSLevel.Verbose = 5, PSOpcode.Create = 0xF,
 * PSTask.CommandStart = 0x66. PowerShell 7 is the only PowerShell of the project, and it ignores the Windows\PowerShell policy key.
 *
 * Measured before the change: the engine read HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging (the 5.1 key), wrote 4104 into
 * Microsoft-Windows-PowerShell/Operational under that provider with Level Information and no task, opcode or keyword, so a key a real PowerShell 7
 * honours did nothing and the key a real one ignores turned logging on.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 7 cases fall on the base. Two pass either way: the WITNESS (with no policy at all
 * the log holds no 4104) and the refusal of the 5.1 key, vacuous on the base because the PowerShellCore log did not exist there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const POWERSHELL_7_KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\ScriptBlockLogging';
const WINDOWS_POWERSHELL_KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging';
const enable = (key: string) => ps(`New-Item -Path "${key}" -Force | Out-Null; Set-ItemProperty -Path "${key}" -Name EnableScriptBlockLogging -Value 1`);
const latest = (property: string) => ps(`(Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=4104})[0].${property}`);

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  const pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('Script Block Logging under PowerShell 7', () => {
  it('WITNESS: with no policy the PowerShellCore log holds no 4104', async () => {
    await ps('Get-Date | Out-Null');
    expect(await ps(`(Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=4104} -ErrorAction SilentlyContinue | Measure-Object).Count`)).toBe('0');
  });

  it('is turned on by the PowerShellCore policy key', async () => {
    await enable(POWERSHELL_7_KEY);
    await ps('Write-Output marker-ps7');
    expect(await latest('Message')).toContain('Write-Output marker-ps7');
  });

  it('is NOT turned on by the Windows PowerShell 5.1 key', async () => {
    await enable(WINDOWS_POWERSHELL_KEY);
    await ps('Write-Output marker-ps51');
    expect(await ps(`(Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=4104} -ErrorAction SilentlyContinue | Measure-Object).Count`)).toBe('0');
  });

  it('writes under the PowerShellCore provider', async () => {
    await enable(POWERSHELL_7_KEY);
    await ps('Write-Output x');
    expect(await latest('ProviderName')).toBe('PowerShellCore');
  });

  it('is Verbose, task CommandStart, opcode Create', async () => {
    await enable(POWERSHELL_7_KEY);
    await ps('Write-Output x');
    expect(await latest('LevelDisplayName')).toBe('Verbose');
    expect(await latest('TaskDisplayName')).toBe('CommandStart');
    expect(await latest('OpcodeDisplayName')).toBe('Create');
  });

  it('carries the Runspace keyword and the provider GUID', async () => {
    await enable(POWERSHELL_7_KEY);
    await ps('Write-Output x');
    expect(await latest('KeywordsDisplayNames')).toContain('Runspace');
    expect(await latest('ProviderId')).toMatch(/f90714a8-5509-434a-bf6d-b1624c8a19a2/i);
  });

  it('is listed under its own name, not under the Windows PowerShell one', async () => {
    const out = await ps('Get-WinEvent -ListLog *PowerShell* | ForEach-Object { $_.LogName }');
    expect(out).toBe('PowerShellCore/Operational');
  });
});
