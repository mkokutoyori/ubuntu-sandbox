/**
 * The PowerShell prompt must reflect the new working directory IMMEDIATELY
 * after Set-Location / cd / Push-Location — not lag one command behind.
 *
 * Root cause: PowerShellSubShell synced the psExecutor cwd only BEFORE
 * dispatching the command, so a directory-changing command updated the
 * device cwd but the prompt was still computed from the stale value.
 * Fixed by re-syncing the cwd AFTER dispatch, before reading getPrompt().
 *
 * Also: Get-Location / pwd render just the `Path` column (real PS
 * PathInfo default view), not a 3-column Path/ProviderPath/Provider table.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
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

describe('Prompt reflects cwd immediately', () => {
  it('Set-Location updates the prompt on the SAME command', async () => {
    const sh = setup();
    await sh.processLine('New-Item -Path C:\\Demo -ItemType Directory -Force | Out-Null');
    const r = await sh.processLine('Set-Location C:\\Demo');
    expect(r.prompt).toBe('PS C:\\Demo> ');
    expect(sh.getPrompt()).toBe('PS C:\\Demo> ');
  });

  it('cd <abs> updates the prompt immediately', async () => {
    const sh = setup();
    const r = await sh.processLine('cd C:\\Windows');
    expect(r.prompt).toBe('PS C:\\Windows> ');
  });

  it('cd .. walks up and updates the prompt immediately', async () => {
    const sh = setup();
    await sh.processLine('cd C:\\Windows');
    const r = await sh.processLine('cd ..');
    expect(r.prompt).toBe('PS C:\\> ');
  });

  it('prompt does NOT lag a command behind', async () => {
    const sh = setup();
    await sh.processLine('New-Item -Path C:\\A -ItemType Directory -Force | Out-Null');
    await sh.processLine('New-Item -Path C:\\B -ItemType Directory -Force | Out-Null');
    const r1 = await sh.processLine('Set-Location C:\\A');
    expect(r1.prompt).toBe('PS C:\\A> ');
    const r2 = await sh.processLine('Set-Location C:\\B');
    expect(r2.prompt).toBe('PS C:\\B> ');
  });
});

describe('Get-Location / pwd output shape', () => {
  it('renders only the Path column', async () => {
    const sh = setup();
    await sh.processLine('New-Item -Path C:\\Demo -ItemType Directory -Force | Out-Null');
    await sh.processLine('Set-Location C:\\Demo');
    const r = await sh.processLine('Get-Location');
    const out = r.output.join('\n');
    expect(out).toContain('Path');
    expect(out).toContain('C:\\Demo');
    expect(out).not.toContain('ProviderPath');
    expect(out).not.toContain('FileSystem');
  });

  it('(Get-Location).Path is still accessible for scripts', async () => {
    const sh = setup();
    await sh.processLine('Set-Location C:\\Windows');
    const r = await sh.processLine('(Get-Location).Path');
    expect(r.output.join('\n')).toContain('C:\\Windows');
  });
});
