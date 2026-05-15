/**
 * ProcessCmdlets — Get-Process / Stop-Process / Start-Process.
 *
 * Routed through `ctx.providers.processes` and shaped to match the column
 * layout that real `Get-Process` produces (Handles / NPM(K) / PM(K) / WS(K) /
 * CPU(s) / Id / SI / ProcessName), so downstream Format-Table and
 * Group-Object stages keep working.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ProcessInfo, IProcessProvider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireProcesses(ctx: CmdletContext): IProcessProvider {
  if (!ctx.providers.processes) {
    throw new PSRuntimeError('Get-Process is not recognized as a process provider operation in this context');
  }
  return ctx.providers.processes;
}

function toPSObject(p: ProcessInfo): Record<string, PSValue> {
  // Strip `.exe` like real Get-Process — matches the legacy executor output.
  const baseName = p.name.replace(/\.exe$/i, '');
  return {
    Handles:        p.handles,
    'NPM(K)':       p.npmK,
    'PM(K)':        Math.floor(p.pmK / 1024),
    'WS(K)':        Math.floor(p.wsK),
    'CPU(s)':       p.cpuSec,
    CPU:            p.cpuSec,
    Id:             p.pid,
    SI:             p.sessionId,
    ProcessName:    baseName,
    Name:           baseName,
    Status:         p.status,
    Owner:          p.owner,
  };
}

function asPSObjects(list: ProcessInfo[]): PSValue {
  return list.map(toPSObject) as PSValue;
}

// ── Get-Process / gps / ps ────────────────────────────────────────────────

export class GetProcessCmdlet implements ICmdlet {
  readonly name = 'get-process';
  readonly aliases = ['gps', 'ps'] as const;

  execute(ctx: CmdletContext): PSValue {
    const procs = requireProcesses(ctx);
    const id    = ctx.named['id'];
    const name  = ctx.named['name'] ?? ctx.positional[0];

    if (id !== undefined && id !== null) {
      const ids = Array.isArray(id) ? id : [id];
      const out: ProcessInfo[] = [];
      for (const v of ids) {
        const found = procs.getProcess(Number(v));
        if (found) out.push(found);
        else ctx.emitError(`Cannot find a process with the process identifier ${v}.`);
      }
      return asPSObjects(out);
    }

    if (name !== undefined && name !== null && name !== '') {
      const names = Array.isArray(name) ? name.map(psValueToString) : [psValueToString(name)];
      const out: ProcessInfo[] = [];
      for (const n of names) {
        if (/[*?]/.test(n)) {
          const pat = new RegExp('^' + n.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          for (const p of procs.listProcesses()) {
            const stripped = p.name.replace(/\.exe$/i, '');
            if (pat.test(p.name) || pat.test(stripped)) out.push(p);
          }
          continue;
        }
        const matches = procs.listProcesses().filter(p =>
          p.name.toLowerCase() === n.toLowerCase() ||
          p.name.toLowerCase() === n.toLowerCase() + '.exe',
        );
        if (matches.length === 0) ctx.emitError(`Cannot find a process with the name "${n}".`);
        out.push(...matches);
      }
      return asPSObjects(out);
    }

    return asPSObjects(procs.listProcesses());
  }
}

// ── Stop-Process / kill / spps ────────────────────────────────────────────

export class StopProcessCmdlet implements ICmdlet {
  readonly name = 'stop-process';
  readonly aliases = ['kill', 'spps'] as const;

  execute(ctx: CmdletContext): PSValue {
    const procs = requireProcesses(ctx);
    const force = ctx.named['force'] === true;
    const id    = ctx.named['id'];
    const name  = ctx.named['name'];

    // Pipeline input: array of process objects (Get-Process | Stop-Process)
    if (ctx.pipeInput !== null && ctx.pipeInput !== undefined && id === undefined && name === undefined) {
      const items = Array.isArray(ctx.pipeInput) ? ctx.pipeInput : [ctx.pipeInput];
      for (const item of items) {
        const pid = (item as Record<string, PSValue>)?.['Id'] ?? (item as Record<string, PSValue>)?.['id'];
        if (pid !== undefined) {
          const msg = procs.killProcess(Number(pid), force);
          if (msg) ctx.emit(msg);
        }
      }
      return null;
    }

    if (id !== undefined && id !== null) {
      const ids = Array.isArray(id) ? id : [id];
      for (const v of ids) {
        const msg = procs.killProcess(Number(v), force);
        if (msg) ctx.emit(msg);
      }
      return null;
    }
    if (name !== undefined && name !== null) {
      const names = Array.isArray(name) ? name : [name];
      for (const n of names) {
        const msg = procs.killProcess(psValueToString(n), force);
        if (msg) ctx.emit(msg);
      }
      return null;
    }

    // Positional: number → id, otherwise → name
    const arg = ctx.positional[0];
    if (arg !== undefined && arg !== null) {
      const asNum = Number(arg);
      const msg = Number.isFinite(asNum) && String(asNum) === String(arg)
        ? procs.killProcess(asNum, force)
        : procs.killProcess(psValueToString(arg), force);
      if (msg) ctx.emit(msg);
    }
    return null;
  }
}

// ── Start-Process / saps ──────────────────────────────────────────────────
//
// We don't actually launch anything in the simulator; we just record that
// it was started. The legacy executor returns nothing on success and an
// error string on failure — keep the same contract.

export class StartProcessCmdlet implements ICmdlet {
  readonly name = 'start-process';
  readonly aliases = ['saps'] as const;

  execute(ctx: CmdletContext): PSValue {
    const filePath = psValueToString(
      ctx.named['filepath'] ?? ctx.named['path'] ?? ctx.positional[0] ?? '',
    );
    if (!filePath) {
      ctx.emitError('Start-Process requires -FilePath');
      return null;
    }
    if (ctx.named['passthru'] === true) {
      // Mimic the PSObject Start-Process -PassThru hands back.
      return {
        Id: 0,
        Name: filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
        Path: filePath,
      } as Record<string, PSValue>;
    }
    return null;
  }
}
