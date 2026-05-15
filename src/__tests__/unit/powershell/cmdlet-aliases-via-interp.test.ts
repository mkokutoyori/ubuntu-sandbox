/**
 * The bash/cmd-style aliases (ls / dir / cd / pwd / cat / type / cp / mv /
 * rm / del / ren / mkdir / rmdir / hostname / whoami) used to bypass the
 * interpreter and go straight to PowerShellExecutor. After the Phase 3
 * close-out they're resolved by ICmdlets registered in the interpreter's
 * registry. This test file pins that behaviour so future bypass-list
 * trims don't regress.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell() {
  const pc = new WindowsPC('windows-pc', 'WIN-ALIASES');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('Bash/cmd-style aliases now go through the interpreter', () => {
  it('pwd → Get-Location returns a Path object', async () => {
    const sh = createShell();
    const out = await run(sh, 'pwd');
    expect(out).toMatch(/path/i);
  });

  it('hostname returns the machine name', async () => {
    const sh = createShell();
    const out = await run(sh, 'hostname');
    expect(out.toLowerCase()).toContain('win-aliases');
  });

  it('whoami returns hostname\\user', async () => {
    const sh = createShell();
    const out = await run(sh, 'whoami');
    expect(out).toContain('\\');
  });

  it('mkdir creates a directory', async () => {
    const sh = createShell();
    await run(sh, 'mkdir C:\\probe-mkdir');
    const out = await run(sh, 'Test-Path C:\\probe-mkdir');
    expect(out.trim()).toBe('True');
  });

  it('ren (Rename-Item) renames a file', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\probe -ItemType Directory -Force');
    await run(sh, 'Set-Content -Path C:\\probe\\old.txt -Value "x"');
    await run(sh, 'ren C:\\probe\\old.txt new.txt');
    const out = await run(sh, 'Test-Path C:\\probe\\new.txt');
    expect(out.trim()).toBe('True');
  });

  it('ls and dir both alias Get-ChildItem on the device filesystem', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\probe-ls -ItemType Directory -Force');
    await run(sh, 'Set-Content -Path C:\\probe-ls\\a.txt -Value "1"');
    const ls  = await run(sh, 'ls C:\\probe-ls');
    const dir = await run(sh, 'dir C:\\probe-ls');
    expect(ls).toContain('a.txt');
    expect(dir).toContain('a.txt');
  });
});
