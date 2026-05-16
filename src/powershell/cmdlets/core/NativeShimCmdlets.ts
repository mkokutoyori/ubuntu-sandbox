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
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

/**
 * Reconstruct the argv the native handlers expect from a CmdletContext.
 * Named flags become `-flag value` (or just `-flag` when value is true).
 */
function rebuildArgs(ctx: CmdletContext): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(ctx.named)) {
    if (v === true) { out.push(`-${k}`); continue; }
    if (v === false || v === null || v === undefined) continue;
    out.push(`-${k}`);
    out.push(psValueToString(v));
  }
  for (const p of ctx.positional) out.push(psValueToString(p));
  return out;
}

function runNative(name: string, ctx: CmdletContext): PSValue {
  if (!ctx.providers.network) {
    throw new PSRuntimeError(`${name} is not recognized in this provider context`);
  }
  const out = ctx.providers.network.runSyncNativeCommand(name, rebuildArgs(ctx));
  if (out === null) {
    throw new PSRuntimeError(`${name} is not recognized in this provider context`);
  }
  return out;
}

class NativeShim implements ICmdlet {
  constructor(public readonly name: string) {}
  readonly aliases = [] as const;
  execute(ctx: CmdletContext): PSValue { return runNative(this.name, ctx); }
}

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
