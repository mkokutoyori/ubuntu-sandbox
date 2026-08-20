/**
 * PowerShell non-terminating errors emitted via ctx.emitError() should
 * render the standard PS 5.1 format:
 *
 *   <Cmdlet> : <message>
 *       + CategoryInfo          : <Category>: (<Target>) [<Cmdlet>], <ExceptionType>
 *       + FullyQualifiedErrorId : <ErrorId>
 *
 * Audit rapport 06, constat MAJEUR: the new cmdlet-based engine only
 * printed "ERROR: <message>" — no cmdlet prefix, no CategoryInfo, no
 * FullyQualifiedErrorId — a regression from the legacy PowerShellExecutor,
 * which did produce these blocks. $Error[0] already carried structured
 * Exception/CategoryInfo/TargetObject data; only the on-screen rendering
 * was wrong.
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

async function exec(line: string): Promise<string> {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  const { subShell } = PowerShellSubShell.create(pc);
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('standard PowerShell error format', () => {
  it('Get-Process <missing> renders the Cmdlet-prefixed CategoryInfo/FullyQualifiedErrorId block', async () => {
    const out = await exec('Get-Process -Name notepad');
    expect(out).toMatch(/^Get-Process : Cannot find a process with the name "notepad"\.$/m);
    expect(out).toMatch(/^\s+\+ CategoryInfo\s+: NotSpecified: \(:\) \[Get-Process\], \w+$/m);
    expect(out).toMatch(/^\s+\+ FullyQualifiedErrorId\s+: \S+$/m);
    expect(out).not.toMatch(/^ERROR:/m);
  });

  it('Get-Service <missing> renders the same standard block', async () => {
    const out = await exec('Get-Service -Name NotARealService');
    expect(out).toMatch(/^Get-Service : Cannot find any service with service name 'NotARealService'\.$/m);
    expect(out).toMatch(/\+ CategoryInfo\s+: NotSpecified: \(:\) \[Get-Service\]/);
    expect(out).toMatch(/\+ FullyQualifiedErrorId\s+: \S+/);
  });

  it('Get-Item <missing path> renders the same standard block', async () => {
    const out = await exec("Get-Item -Path 'C:\\does\\not\\exist.txt'");
    expect(out).toMatch(/^Get-Item : Cannot find path/m);
    expect(out).toMatch(/\+ CategoryInfo\s+: NotSpecified: \(:\) \[Get-Item\]/);
    expect(out).toMatch(/\+ FullyQualifiedErrorId\s+: \S+/);
  });

  it('$Error[0] still exposes structured Exception/CategoryInfo/FullyQualifiedErrorId', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);
    await subShell.processLine('Get-Process -Name notepad');
    const msg = (await subShell.processLine('$Error[0].Exception.Message')).output.join('\n');
    const cat = (await subShell.processLine('$Error[0].CategoryInfo.Category')).output.join('\n');
    const errId = (await subShell.processLine('$Error[0].FullyQualifiedErrorId')).output.join('\n');
    expect(msg).toMatch(/Cannot find a process with the name "notepad"/);
    // The stored Exception.Message must not carry the display-only prefix.
    expect(msg).not.toMatch(/^Get-Process :/);
    expect(cat).toBe('NotSpecified');
    expect(errId).toMatch(/WriteErrorException/);
  });

  it('a message that already hand-embeds "<Cmdlet> : " is not double-prefixed', async () => {
    // A handful of cmdlets (e.g. Get-Alias) construct their own
    // "<Cmdlet> : ..." string before calling emitError(); the renderer
    // must recognise and strip it rather than prefixing twice.
    const out = await exec('Get-Alias -Name doesnotexist');
    expect(out).toMatch(/^Get-Alias : /m);
    expect(out).not.toMatch(/Get-Alias : Get-Alias :/);
  });
});
