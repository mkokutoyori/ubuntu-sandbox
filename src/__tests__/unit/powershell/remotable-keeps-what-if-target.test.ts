/*
 * Structure — remotable() wraps a cmdlet so that -ComputerName can send it to another machine. The wrapper has to keep
 * what the runtime reads from the cmdlet besides execute: the target named on the "What if" line of a cmdlet that asks for
 * confirmation. That target is a method of the cmdlet's class, which copying the cmdlet's own properties leaves behind, so
 * "Clear-DnsServerStatistics -WhatIf" named an empty target.
 * Discrimination (run on the tree before the change): 1 of 3 cases falls, "keeps the target the cmdlet names". The two that
 * pass either way are CONTROLS: a cmdlet that names no target is wrapped without one, and a local call still reaches the
 * cmdlet it wraps.
 */
import { describe, it, expect } from 'vitest';
import type { ICmdlet } from '@/powershell/cmdlets/ICmdlet';
import type { CmdletContext } from '@/powershell/cmdlets/CmdletContext';
import { remotable } from '@/powershell/cmdlets/remoteDispatch';

class WithTarget implements ICmdlet {
  readonly name = 'clear-thing';
  readonly displayName = 'Clear-Thing';
  readonly aliases = [] as const;
  readonly supportsShouldProcess = true as const;
  private readonly prefix = 'server:';

  whatIfTarget(ctx: CmdletContext): string {
    return `${this.prefix}${String(ctx.named['zonename'] ?? '')}`;
  }

  execute(): string {
    return 'executed';
  }
}

class WithoutTarget implements ICmdlet {
  readonly name = 'get-thing';
  readonly displayName = 'Get-Thing';
  readonly aliases = [] as const;

  execute(): string {
    return 'executed';
  }
}

const context = (named: Record<string, string> = {}): CmdletContext => ({ named, positional: [], providers: {} } as unknown as CmdletContext);

describe('the wrapper of a cmdlet that can be sent to another computer', () => {
  it('keeps the target the cmdlet names, with the cmdlet as its receiver', () => {
    const wrapped = remotable('Clear-Thing', new WithTarget());
    expect(wrapped.whatIfTarget?.(context({ zonename: 'corp.test' }))).toBe('server:corp.test');
  });

  it('CONTROL: a cmdlet that names no target is wrapped without one', () => {
    expect(remotable('Get-Thing', new WithoutTarget()).whatIfTarget).toBeUndefined();
  });

  it('CONTROL: a call without a remote computer still reaches the cmdlet it wraps', () => {
    expect(remotable('Get-Thing', new WithoutTarget()).execute(context())).toBe('executed');
  });
});
