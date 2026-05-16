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

type SessionHandle = {
  enterPowerShell(): void;
  setInputBuf(v: string): void;
  getInputBuf(): string;
  onSubShellTab(reverse?: boolean): void;
};

function psSession(): SessionHandle {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  const s = new WindowsTerminalSession('t1', pc) as unknown as SessionHandle;
  s.enterPowerShell();
  return s;
}

describe('Session Tab key — PowerShell-style cycling', () => {
  it('unique cmdlet completes inline with NO trailing space (like real PS)', () => {
    const s = psSession();
    s.setInputBuf('Get-Childi');
    s.onSubShellTab();
    expect(s.getInputBuf()).toBe('Get-ChildItem');
  });

  it('first Tab inserts the first match; repeated Tab cycles forward', () => {
    const s = psSession();
    s.setInputBuf('Get-LocalGr');
    s.onSubShellTab();
    const first = s.getInputBuf();
    expect(first.toLowerCase().startsWith('get-localgroup')).toBe(true);
    s.onSubShellTab();
    const second = s.getInputBuf();
    expect(second).not.toBe(first);
    expect(second.toLowerCase().startsWith('get-localgroup')).toBe(true);
  });

  it('Shift+Tab cycles backward to the previous candidate', () => {
    const s = psSession();
    s.setInputBuf('Get-LocalGr');
    s.onSubShellTab();        // -> candidate[0]
    const a = s.getInputBuf();
    s.onSubShellTab();        // -> candidate[1]
    const b = s.getInputBuf();
    s.onSubShellTab(true);    // back -> candidate[0]
    expect(s.getInputBuf()).toBe(a);
    expect(b).not.toBe(a);
  });

  it('keeps the prefix before the completed token intact', () => {
    const s = psSession();
    s.setInputBuf('Get-Process | Where-Object Na');
    s.onSubShellTab();
    expect(s.getInputBuf().startsWith('Get-Process | Where-Object ')).toBe(true);
  });
});

describe('Variable completion', () => {
  it('$ + prefix completes a user-defined variable', async () => {
    const sh = setup();
    await sh.processLine('$myFavoriteVar = 42');
    const c = sh.getCompletions!('$myFav');
    expect(c.map(x => x.toLowerCase())).toContain('$myfavoritevar');
  });

  it('completes automatic variables', async () => {
    const sh = setup();
    const c = sh.getCompletions!('$tr');
    expect(c).toContain('$true');
  });

  it('$env: scope completes environment variables', async () => {
    const sh = setup();
    const c = sh.getCompletions!('$env:COMPUTERN');
    expect(c.some(x => x.toLowerCase().startsWith('$env:computern'))).toBe(true);
  });
});

describe('Parameter completion', () => {
  it('-<prefix> completes a cmdlet declared parameter', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-Process -N');
    expect(c).toContain('-Name');
  });

  it('always offers the common parameters', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-ChildItem -Err');
    expect(c).toContain('-ErrorAction');
  });

  it('a lone dash lists many parameters', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-Service -');
    expect(c).toContain('-Name');
    expect(c).toContain('-DisplayName');
    expect(c.length).toBeGreaterThan(5);
  });

  it('does NOT treat a leading dash in command position as a parameter', async () => {
    const sh = setup();
    // first token starting with '-' is not a parameter context
    const c = sh.getCompletions!('-No');
    expect(c.every(x => !x.startsWith('-'))).toBe(true);
  });
});

describe('Pipeline-aware command position', () => {
  it('token right after a pipe completes as a command', async () => {
    const sh = setup();
    const c = sh.getCompletions!('Get-Process | Sort-Ob');
    expect(c).toContain('Sort-Object');
  });

  it('token after a semicolon completes as a command', async () => {
    const sh = setup();
    const c = sh.getCompletions!('$x = 1; Get-Pro');
    expect(c).toContain('Get-Process');
  });
});
