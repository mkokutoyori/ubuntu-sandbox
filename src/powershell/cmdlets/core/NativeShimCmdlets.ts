/**
 * NativeShimCmdlets — wrap the synchronous native CLI commands
 * (ipconfig / netsh / arp / route / getmac / systeminfo / ver / nslookup)
 * as ICmdlets so they resolve through the interpreter instead of the
 * legacy DEVICE_ONLY_COMMANDS bypass.
 *
 * The underlying handlers live on WindowsPC.runSyncNativeCommand(); the
 * shims just rebuild the original argv from CmdletContext (positional
 * args + named flags rendered back as `-flag value`).
 *
 * Async siblings (ping / tracert) stay routed through the executor for
 * now — making the PSRuntime tree-walker async would be a much larger
 * refactor and isn't blocking deletion.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { NativeCommandNeedsAsync, nativeArgv } from '@/powershell/nativeAsync';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { applyFindstr } from '@/network/devices/windows/textFilters';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';

function runNative(name: string, ctx: CmdletContext): PSValue {
  if (!ctx.providers.network) {
    throw new PSRuntimeError(commandNotFoundMessage(name));
  }
  const args = nativeArgv(ctx.positional, ctx.named);
  const out = ctx.providers.network.runSyncNativeCommand(name, args);
  if (out === null) {
    throw new NativeCommandNeedsAsync(name, args);
  }
  return out;
}

class NativeShim implements ICmdlet {
  constructor(public readonly name: string) {}
  readonly aliases = [] as const;
  execute(ctx: CmdletContext): PSValue { return runNative(this.name, ctx); }
}

class TextFilterShim implements ICmdlet {
  constructor(public readonly name: string) {}
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const piped = ctx.pipeInput;
    if (piped === null || piped === undefined) return runNative(this.name, ctx);
    const text = (Array.isArray(piped) ? piped : [piped]).map(psValueToString).join('\n');
    const argv = nativeArgv(ctx.positional, ctx.named);
    const filtered = applyFindstr(text, [this.name, ...argv].join(' '));
    return filtered === '' ? null : (filtered.split('\n') as unknown as PSValue);
  }
}

export const FindstrCmdlet = new TextFilterShim('findstr');

export const IpconfigCmdlet  = new NativeShim('ipconfig');
export const NetshCmdlet     = new NativeShim('netsh');
export const ArpCmdlet       = new NativeShim('arp');
export const RouteCmdlet     = new NativeShim('route');
export const GetmacCmdlet    = new NativeShim('getmac');
export const SysteminfoCmdlet = new NativeShim('systeminfo');
export const VerCmdlet       = new NativeShim('ver');
export const NslookupCmdlet  = new NativeShim('nslookup');
export const NetCmdlet       = new NativeShim('net');
export const VolCmdlet       = new NativeShim('vol');
export const ChcpCmdlet      = new NativeShim('chcp');
// `sc` is canonically the Set-Content alias in PowerShell, but this
// simulator exposes cmd service-control tools bare in PS for
// cmd↔PS coherence (same as `net` / `netsh`). `sc.exe` is the
// always-correct explicit form.
export const ScCmdlet        = new NativeShim('sc');
export const ScExeCmdlet     = new NativeShim('sc.exe');
