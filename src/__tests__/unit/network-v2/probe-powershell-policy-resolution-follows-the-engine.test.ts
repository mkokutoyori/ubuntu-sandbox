/**
 * Probe: PowerShell 7 resolves its logging policies the way the engine does.
 *
 * Reference (rule 8): PowerShell source v7.5.0, engine/Utils.cs (GetPolicySetting, GetPolicySettingFromGPOImpl): on Windows the registry is read first, the
 * machine hive (HKLM) then the user hive (HKCU), under Software\Policies\Microsoft\PowerShellCore\<section>; if that key holds the DWORD
 * UseWindowsPowerShellPolicySetting = 1 the Windows PowerShell key Software\Policies\Microsoft\Windows\PowerShell\<section> is read instead; a policy with no
 * known value set counts as undefined; an undefined policy falls through to powershell.config.json, the machine file (PSHOME) then the user's, under
 * PowerShellPolicies (engine/PSConfiguration.cs). about_Logging_Windows (PowerShell 7.6) names the same three sources for script block logging.
 *
 * Measured before the change: only HKLM\...\PowerShellCore\<section> was read, so the HKCU policy, the Windows PowerShell fallback flag and powershell.config.json
 * were ignored, and a registry key holding no known value was treated as a decision rather than as an undefined policy.
 *
 * Discrimination (git stash push -- src/network src/powershell): 4 of 9 cases fall on the base. Five pass either way: the WITNESS (HKLM policy), the machine policy
 * winning over the user one, the Windows PowerShell key alone staying ignored, the flag pointing at a missing Windows key, and the registry policy overriding
 * the config file (the base never read the file, so the registry value decided alone).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const CORE = (hive: string): string => `${hive}:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\ScriptBlockLogging`;
const WINDOWS = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging';
const SYSTEM_CONFIG = 'C:\\Program Files\\PowerShell\\7\\powershell.config.json';

const setValue = (path: string, name: string, value: number): Promise<string> =>
  ps(`New-Item -Path "${path}" -Force | Out-Null; Set-ItemProperty -Path "${path}" -Name ${name} -Value ${value}`);
const writeConfig = (json: string): Promise<string> =>
  ps(`New-Item -ItemType Directory -Force -Path "C:\\Program Files\\PowerShell\\7" | Out-Null; Set-Content -Path "${SYSTEM_CONFIG}" -Value '${json}'`);
const logged = async (): Promise<boolean> => {
  await ps('Write-Output policy-marker');
  return (await ps(`Get-WinEvent -FilterHashtable @{LogName='PowerShellCore/Operational'; Id=4104} -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }`)).includes('policy-marker');
};

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('registry policy', () => {
  it('WITNESS: the machine policy turns it on', async () => {
    await setValue(CORE('HKLM'), 'EnableScriptBlockLogging', 1);
    expect(await logged()).toBe(true);
  });

  it('the user policy turns it on when the machine has none', async () => {
    await setValue(CORE('HKCU'), 'EnableScriptBlockLogging', 1);
    expect(await logged()).toBe(true);
  });

  it('the machine policy wins over the user one', async () => {
    await setValue(CORE('HKLM'), 'EnableScriptBlockLogging', 0);
    await setValue(CORE('HKCU'), 'EnableScriptBlockLogging', 1);
    expect(await logged()).toBe(false);
  });

  it('the Windows PowerShell key alone stays ignored', async () => {
    await setValue(WINDOWS, 'EnableScriptBlockLogging', 1);
    expect(await logged()).toBe(false);
  });

  it('UseWindowsPowerShellPolicySetting = 1 reads the Windows PowerShell key instead', async () => {
    await setValue(CORE('HKLM'), 'UseWindowsPowerShellPolicySetting', 1);
    await setValue(WINDOWS, 'EnableScriptBlockLogging', 1);
    expect(await logged()).toBe(true);
  });

  it('the flag pointing at a missing Windows key leaves it off', async () => {
    await setValue(CORE('HKLM'), 'UseWindowsPowerShellPolicySetting', 1);
    expect(await logged()).toBe(false);
  });
});

describe('powershell.config.json', () => {
  it('turns it on when no registry policy is defined', async () => {
    await writeConfig('{"PowerShellPolicies":{"ScriptBlockLogging":{"EnableScriptBlockLogging":true}}}');
    expect(await logged()).toBe(true);
  });

  it('is overridden by a registry policy that is defined', async () => {
    await writeConfig('{"PowerShellPolicies":{"ScriptBlockLogging":{"EnableScriptBlockLogging":true}}}');
    await setValue(CORE('HKLM'), 'EnableScriptBlockLogging', 0);
    expect(await logged()).toBe(false);
  });

  it('is not shadowed by a registry key that holds no known value', async () => {
    await writeConfig('{"PowerShellPolicies":{"ScriptBlockLogging":{"EnableScriptBlockLogging":true}}}');
    await setValue(CORE('HKLM'), 'SomethingElse', 1);
    expect(await logged()).toBe(true);
  });
});
