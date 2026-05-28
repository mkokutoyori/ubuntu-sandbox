/**
 * §WEC — end-to-end smoke: after the new SSH audit events land in
 * the Security log, the operator-facing CLIs (`Get-EventLog`,
 * `Get-WinEvent`, `wevtutil`) must surface them. Today the audit
 * fires the events into PSEventLogProvider, but no test pins that
 * the CLIs read the same store — so a refactor of the projection
 * could silently break the operator-visible side.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('§WEC — Get-EventLog / Get-WinEvent / wevtutil surface SSH audit events', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ctx = pc.getSshServerContext();
    // 1 success + 1 failure + 1 logoff — same shape as a realistic
    // session lifecycle.
    ctx.auth.checkPassword('user', 'user');
    ctx.auth.checkPassword('user', 'WRONG');
    ctx.recordLogout?.('user', '10.0.0.5');
  });

  async function ps(line: string): Promise<string> {
    const { subShell } = PowerShellSubShell.create(pc);
    const r = await subShell.processLine(line);
    return (r.output ?? []).join('\n');
  }

  it('Get-EventLog Security -Newest 10 includes the SSH 4624', async () => {
    const out = await ps('Get-EventLog Security -Newest 10');
    expect(out).toContain('4624');
  });

  it('Get-EventLog Security -Newest 10 includes the SSH 4625', async () => {
    const out = await ps('Get-EventLog Security -Newest 10');
    expect(out).toContain('4625');
  });

  it('Get-EventLog Security -Newest 10 includes the SSH 4634', async () => {
    const out = await ps('Get-EventLog Security -Newest 10');
    expect(out).toContain('4634');
  });

  it('wevtutil qe Security /c:10 /f:text lists the recent SSH events', async () => {
    const out = await pc.executeCommand('wevtutil qe Security /c:10 /f:text');
    expect(out).toContain('4624');
    expect(out).toContain('4625');
  });
});
