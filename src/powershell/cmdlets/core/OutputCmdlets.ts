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
    // Write-Output emits ONE item per positional arg (matches real PS).
    // `echo hello world` writes two lines: "hello" then "world".
    // Falls back to the pipeline input when there are no explicit args.
    const args: PSValue[] = ctx.positional.length > 0
      ? ctx.positional
      : ctx.pipeInput !== undefined && ctx.pipeInput !== null
        ? (Array.isArray(ctx.pipeInput) ? ctx.pipeInput : [ctx.pipeInput])
        : [];
    if (args.length === 0) { ctx.emit(''); return null; }
    for (const item of args) {
      if (Array.isArray(item)) for (const sub of item) ctx.emit(psValueToString(sub));
      else ctx.emit(psValueToString(item));
    }
    return args.length === 1 ? args[0] : args;
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
    const raw = ctx.pipeInput ?? ctx.positional[0] ?? null;
    const items = raw === null || raw === undefined
      ? []
      : Array.isArray(raw) ? raw : [raw];

    const allObjects = items.length > 0
      && items.every(v => v !== null && typeof v === 'object' && !Array.isArray(v));

    let text: string;
    if (allObjects) {
      // Same shape as default Format-Table rendering — NOT the inline
      // "Key=Value;" dump psValueToString produces.
      const keys = Object.keys(items[0] as Record<string, PSValue>);
      const w = 15;
      const header = keys.map(k => k.padEnd(w)).join(' ');
      const sep    = keys.map(() => '-'.repeat(w)).join(' ');
      const rows = items.map(it => {
        const rec = it as Record<string, PSValue>;
        return keys.map(k => {
          const kk = Object.keys(rec).find(x => x.toLowerCase() === k.toLowerCase()) ?? k;
          return psValueToString(rec[kk] ?? '').padEnd(w);
        }).join(' ');
      });
      text = ['', header, sep, ...rows, ''].join('\n');
    } else {
      text = items.map(v => psValueToString(v)).join('\n');
    }
    // PS terminates Out-String with a trailing newline.
    if (!text.endsWith('\n')) text += '\n';

    if (ctx.named['stream'] === true) {
      return text.split('\n');
    }
    return text;
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
