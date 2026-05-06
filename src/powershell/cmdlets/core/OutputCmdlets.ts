/**
 * OutputCmdlets — Write-*, Out-* cmdlets.
 *
 * None of these require system providers; they manipulate the output stream only.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

// ─── Write-Output / echo ───────────────────────────────────────────────────

export class WriteOutputCmdlet implements ICmdlet {
  readonly name = 'write-output';
  readonly aliases = ['echo'] as const;

  execute(ctx: CmdletContext): PSValue {
    const val = ctx.positional[0] ?? ctx.pipeInput ?? null;
    if (Array.isArray(val)) {
      for (const item of val) ctx.emit(psValueToString(item));
    } else {
      ctx.emit(psValueToString(val));
    }
    return val;
  }
}

// ─── Write-Host ────────────────────────────────────────────────────────────

export class WriteHostCmdlet implements ICmdlet {
  readonly name = 'write-host';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const parts: string[] = [];
    for (const p of ctx.positional) parts.push(psValueToString(p));
    if (parts.length === 0 && ctx.pipeInput !== null && ctx.pipeInput !== undefined)
      parts.push(psValueToString(ctx.pipeInput));

    const sep = ctx.named['separator'] !== undefined ? psValueToString(ctx.named['separator']) : ' ';
    ctx.emit(parts.join(sep));
    return null;
  }
}

// ─── Write-Error ───────────────────────────────────────────────────────────

export class WriteErrorCmdlet implements ICmdlet {
  readonly name = 'write-error';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const msg = psValueToString(ctx.named['message'] ?? ctx.positional[0] ?? ctx.pipeInput ?? '');
    ctx.emitError(msg);
    return null;
  }
}

// ─── Write-Warning ─────────────────────────────────────────────────────────

export class WriteWarningCmdlet implements ICmdlet {
  readonly name = 'write-warning';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const msg = psValueToString(ctx.positional[0] ?? ctx.pipeInput ?? '');
    ctx.emit(`WARNING: ${msg}`);
    return null;
  }
}

// ─── Write-Verbose ─────────────────────────────────────────────────────────

export class WriteVerboseCmdlet implements ICmdlet {
  readonly name = 'write-verbose';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const pref = psValueToString(ctx.env.get('VerbosePreference') ?? 'SilentlyContinue');
    if (pref === 'Continue' || pref === 'Inquire') {
      const msg = psValueToString(ctx.positional[0] ?? ctx.pipeInput ?? '');
      ctx.emit(`VERBOSE: ${msg}`);
    }
    return null;
  }
}

// ─── Write-Debug / Write-Progress / Write-Information (no-ops) ────────────

class NoOpWriteCmdlet implements ICmdlet {
  constructor(readonly name: string, readonly aliases: readonly string[] = []) {}
  execute(_ctx: CmdletContext): PSValue { return null; }
}

export const WriteDebugCmdlet       = new NoOpWriteCmdlet('write-debug');
export const WriteProgressCmdlet    = new NoOpWriteCmdlet('write-progress');
export const WriteInformationCmdlet = new NoOpWriteCmdlet('write-information');

// ─── Out-Null ──────────────────────────────────────────────────────────────

export class OutNullCmdlet implements ICmdlet {
  readonly name = 'out-null';
  readonly aliases = [] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Out-String ────────────────────────────────────────────────────────────

export class OutStringCmdlet implements ICmdlet {
  readonly name = 'out-string';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return psValueToString(ctx.pipeInput ?? ctx.positional[0] ?? null);
  }
}

// ─── Out-Host ──────────────────────────────────────────────────────────────

export class OutHostCmdlet implements ICmdlet {
  readonly name = 'out-host';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    ctx.emit(psValueToString(ctx.pipeInput ?? ctx.positional[0] ?? null));
    return null;
  }
}

// ─── Out-File / Out-Printer (stubs) ───────────────────────────────────────

export const OutFileCmdlet    = new NoOpWriteCmdlet('out-file');
export const OutPrinterCmdlet = new NoOpWriteCmdlet('out-printer');
