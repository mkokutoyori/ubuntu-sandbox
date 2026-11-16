/**
 * Probe: the header of a transcript is the TranscriptPrologue resource of PowerShell.
 *
 * Reference (rule 8): PowerShell source v7.5.0, resources/InternalHostUserInterfaceStrings.resx, TranscriptPrologue:
 * "**********************\nPowerShell transcript start\nStart time: {0:yyyyMMddHHmmss}\nUsername: {1}\nRunAs User: {2}\nConfiguration Name: {3}\n
 * Machine: {4} ({5})\nHost Application: {6}\nProcess ID: {7}\n{8}\n**********************", the {8} block being the $PSVersionTable lines. The C# that fills the
 * fields is not reachable from this session: their order in {8} (PSVersion, PSEdition, GitCommitId, OS, Platform, PSCompatibleVersions, PSRemotingProtocolVersion,
 * SerializationVersion, WSManStackVersion), the OS string "Microsoft Windows NT 10.0.19045.0" and the host application path come from captured transcripts and the
 * simulator's own $PSVersionTable / $PID, which this header now reads (one table). The closing "PowerShell transcript end" epilogue is not written.
 *
 * Measured before the change: the header carried an ISO start time and only Username and Machine, the layout of no PowerShell resource.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 6 cases fall on the base. The witness (the transcript file is created and holds the typed
 * command) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\PowerShellCore\\Transcription';

async function transcript(): Promise<string> {
  await ps(`New-Item -Path "${KEY}" -Force | Out-Null; Set-ItemProperty -Path "${KEY}" -Name EnableTranscripting -Value 1; Set-ItemProperty -Path "${KEY}" -Name OutputDirectory -Value "C:\\Transcripts"`);
  await ps('Write-Output marker');
  return ps('Get-Content (Get-ChildItem C:\\Transcripts -Filter PowerShell_transcript*.txt | Select-Object -First 1).FullName -Raw');
}

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('transcript header', () => {
  it('WITNESS: the transcript holds the typed command', async () => {
    expect(await transcript()).toContain('Write-Output marker');
  });

  it('opens with the banner and the start time in yyyyMMddHHmmss', async () => {
    const text = await transcript();
    expect(text).toMatch(/^\*{22}\nPowerShell transcript start\nStart time: \d{14}\n/);
  });

  it('carries Username, RunAs User and an empty Configuration Name', async () => {
    const text = await transcript();
    expect(text).toMatch(/\nUsername: \S+\\Administrator\nRunAs User: \S+\\Administrator\nConfiguration Name: \n/);
  });

  it('names the machine with its operating system, the host application and the process id', async () => {
    const text = await transcript();
    expect(text).toContain('Machine: PC1 (Microsoft Windows NT 10.0.19045.0)\n');
    expect(text).toContain('Host Application: C:\\Program Files\\PowerShell\\7\\pwsh.exe\n');
    expect(text).toContain('Process ID: 1234\n');
  });

  it('lists the $PSVersionTable values', async () => {
    const text = await transcript();
    expect(text).toContain('PSVersion: 7.6.0\nPSEdition: Core\nGitCommitId: 7.6.0\nOS: Microsoft Windows 10.0.19045\nPlatform: Win32NT\n');
    expect(text).toContain('WSManStackVersion: 3.0\n**********************\n');
  });

  it('agrees with $PSVersionTable and $PID of the same session', async () => {
    const text = await transcript();
    const version = await ps('$PSVersionTable.PSVersion.ToString()');
    expect(text).toContain(`PSVersion: ${version}`);
    expect(text).toContain(`Process ID: ${await ps('$PID')}`);
  });
});
