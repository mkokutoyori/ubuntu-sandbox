/**
 * PowerShell-style Tab completion (PowerShellSubShell.getCompletions):
 *   - first token  → full cmdlet registry + aliases (open/closed: pulls
 *                     from the live registry, not a static ~60-name list)
 *   - later tokens → device filesystem path completion, directories get
 *                     a trailing backslash so tabbing can go deeper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function setup() {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

describe('Command-name completion', () => {
  it('completes a cmdlet prefix from the full registry', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-Childi');
    expect(c).toContain('Get-ChildItem');
  });

  it('completes compound-noun cmdlets with canonical casing', async () => {
    const sh = setup();
    expect(sh.getCompletions!('Get-LocalGroupMem')).toContain('Get-LocalGroupMember');
    expect(sh.getCompletions!('Get-NetIPAddr')).toContain('Get-NetIPAddress');
  });

  it('is case-insensitive', async () => {
    const sh = setup();
    expect(sh.getCompletions!('get-pro')).toContain('Get-Process');
  });

  it('completes aliases too', async () => {
    const sh = setup();
    const c = sh.getCompletions!('gc');
    expect(c).toContain('gcm');
  });

  it('returns many candidates for a broad prefix (not a 20-cap stub)', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-');
    expect(c.length).toBeGreaterThan(30);
    expect(c.every(n => n.toLowerCase().startsWith('get-'))).toBe(true);
  });

  it('unknown prefix → no candidates', async () => {
    const sh = setup();
    expect(sh.getCompletions!('Zzz-Nope')).toEqual([]);
  });
});

describe('Filesystem path completion', () => {
  it('completes a directory in the cwd and appends a backslash', async () => {
    const sh = setup();
    await sh.processLine('New-Item -Path C:\\Demo -ItemType Directory -Force | Out-Null');
    await sh.processLine('Set-Location C:\\');
    const c = sh.getCompletions!('Get-ChildItem De');
    expect(c).toContain('Demo\\');
  });

  it('completes a file by prefix', async () => {
    const sh = setup();
    await sh.processLine('Set-Content -Path C:\\report.txt -Value hi');
    await sh.processLine('Set-Location C:\\');
    const c = sh.getCompletions!('Get-Content rep');
    expect(c).toContain('report.txt');
  });

  it('completes inside an absolute sub-path', async () => {
    const sh = setup();
    await sh.processLine('New-Item -Path C:\\Proj -ItemType Directory -Force | Out-Null');
    await sh.processLine('New-Item -Path C:\\Proj\\srcdir -ItemType Directory -Force | Out-Null');
    const c = sh.getCompletions!('Set-Location C:\\Proj\\sr');
    expect(c).toContain('C:\\Proj\\srcdir\\');
  });

  it('no path match → empty list', async () => {
    const sh = setup();
    await sh.processLine('Set-Location C:\\');
    expect(sh.getCompletions!('Get-Content zzzznope')).toEqual([]);
  });
});

describe('Session Tab key wires through to the sub-shell', () => {
  it('single cmdlet match completes inline with a trailing space', () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const session = new WindowsTerminalSession('t1', pc) as unknown as {
      enterPowerShell(): void;
      setInputBuf(v: string): void;
      getInputBuf(): string;
      onSubShellTab(): void;
    };
    session.enterPowerShell();
    session.setInputBuf('Get-Childi');
    session.onSubShellTab();
    expect(session.getInputBuf()).toBe('Get-ChildItem ');
  });

  it('ambiguous prefix extends to the common prefix', () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const session = new WindowsTerminalSession('t1', pc) as unknown as {
      enterPowerShell(): void;
      setInputBuf(v: string): void;
      getInputBuf(): string;
      onSubShellTab(): void;
    };
    session.enterPowerShell();
    session.setInputBuf('Get-LocalGr');
    session.onSubShellTab();
    // Get-LocalGroup / Get-LocalGroupMember share the "Get-LocalGroup" prefix
    expect(session.getInputBuf().toLowerCase()).toContain('get-localgroup');
  });
});
