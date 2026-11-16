/**
 * Probe: Start-Transcript and Stop-Transcript write the transcript, its invocation headers and its epilogue.
 *
 * References (rule 8): PowerShell source v7.5.0: Microsoft.PowerShell.ConsoleHost/resources/TranscriptStrings.resx ("Transcript started, output file is {0}", "Transcript stopped,
 * output file is {0}", "Transcription cannot be started due to the error: {0}", "File {0} already exists and {1} was specified."), InternalHostUserInterfaceStrings.resx
 * (TranscriptPrologue, MinimalTranscriptPrologue, TranscriptEpilogue "**********************\nPowerShell transcript end\nEnd time: {0:yyyyMMddHHmmss}\n
 * **********************", HostNotTranscribing "The host is not currently transcribing.", CommandStartTime "Command start time: {0}"). The cmdlet parameters are those of the
 * Start-Transcript documentation (-Path, -OutputDirectory, -Append, -Force, -NoClobber, -IncludeInvocationHeader, -UseMinimalHeader). The C# that lays the invocation header
 * around each command is not reachable from this session: it is written as the banner, "Command start time: <stamp>", the banner, from captured transcripts.
 *
 * Measured before the change: neither cmdlet existed ("not recognized"), so a transcript could only be started by policy and never ended (no epilogue), and the
 * EnableInvocationHeader policy value was stored and never read (rule 6).
 *
 * Discrimination (git stash push -- src/network src/powershell): 9 of 10 cases fall on the base. The case that expects nothing after Stop-Transcript passes either way (vacuous
 * on a base with no such cmdlet).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const FILE = 'C:\\Temp\\t.txt';
const read = (): Promise<string> => ps(`Get-Content ${FILE} -Raw`);

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('Start-Transcript and Stop-Transcript', () => {
  it('Start-Transcript says where the transcript goes', async () => {
    expect(await ps(`Start-Transcript -Path ${FILE}`)).toBe(`Transcript started, output file is ${FILE}`);
  });

  it('records the commands typed afterwards, not the Start-Transcript line itself', async () => {
    await ps(`Start-Transcript -Path ${FILE}`);
    await ps('Write-Output marker');
    const text = await read();
    expect(text).toContain('PS> Write-Output marker\nmarker');
    expect(text).not.toContain('PS> Start-Transcript');
  });

  it('opens with the prologue banner', async () => {
    await ps(`Start-Transcript -Path ${FILE}`);
    expect(await read()).toMatch(/^\*{22}\nPowerShell transcript start\nStart time: \d{14}\nUsername: /);
  });

  it('-UseMinimalHeader writes the minimal prologue', async () => {
    await ps(`Start-Transcript -Path ${FILE} -UseMinimalHeader`);
    expect(await read()).toMatch(/^\*{22}\nPowerShell transcript start\nStart time: \d{14}\n\*{22}$/);
  });

  it('Stop-Transcript writes the epilogue and says where the transcript is', async () => {
    await ps(`Start-Transcript -Path ${FILE}`);
    expect(await ps('Stop-Transcript')).toBe(`Transcript stopped, output file is ${FILE}`);
    expect(await read()).toMatch(/\*{22}\nPowerShell transcript end\nEnd time: \d{14}\n\*{22}$/);
  });

  it('records nothing once stopped', async () => {
    await ps(`Start-Transcript -Path ${FILE}`);
    await ps('Stop-Transcript');
    await ps('Write-Output after');
    expect(await read()).not.toContain('after');
  });

  it('Stop-Transcript with no transcript is an error', async () => {
    expect(await ps('Stop-Transcript')).toContain('The host is not currently transcribing.');
  });

  it('-NoClobber refuses an existing file, -Append keeps it', async () => {
    await ps(`Start-Transcript -Path ${FILE}`);
    await ps('Stop-Transcript');
    expect(await ps(`Start-Transcript -Path ${FILE} -NoClobber`)).toContain(`File ${FILE} already exists and NoClobber was specified.`);
    await ps(`Start-Transcript -Path ${FILE} -Append`);
    await ps('Stop-Transcript');
    expect((await read()).match(/PowerShell transcript start/g)?.length).toBe(1);
  });

  it('-IncludeInvocationHeader puts a start time before each command', async () => {
    await ps(`Start-Transcript -Path ${FILE} -IncludeInvocationHeader`);
    await ps('Write-Output marker');
    expect(await read()).toMatch(/\*{22}\nCommand start time: \d{14}\n\*{22}\nPS> Write-Output marker\n/);
  });

  it('the EnableInvocationHeader policy puts the start time before each command of the policy transcript', async () => {
    const key = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\Transcription';
    await ps(`New-Item -Path "${key}" -Force | Out-Null; Set-ItemProperty -Path "${key}" -Name EnableTranscripting -Value 1; Set-ItemProperty -Path "${key}" -Name EnableInvocationHeader -Value 1; Set-ItemProperty -Path "${key}" -Name OutputDirectory -Value "C:\\Pol"`);
    await ps('Write-Output marker');
    const text = await ps('Get-Content (Get-ChildItem C:\\Pol -Filter PowerShell_transcript*.txt | Select-Object -First 1).FullName -Raw');
    expect(text).toMatch(/\*{22}\nCommand start time: \d{14}\n\*{22}\nPS> Write-Output marker\n/);
  });
});
