/**
 * Windows taskkill command — terminate processes by PID or image name.
 *
 * Matches real Windows taskkill.exe output exactly.
 *
 * Supports:
 *   - taskkill /PID <pid> [/F] [/T]
 *   - taskkill /IM <name> [/F] [/T]
 *   - taskkill /FI "filter" [/F] [/T]
 *   - /F = force termination (without it, sends WM_CLOSE)
 *   - /T = tree kill (terminate child processes)
 *   - /FI "filter" = filter processes (same syntax as tasklist)
 */

import type { WindowsProcessManager, WindowsProcess } from './WindowsProcessManager';

export interface TaskkillContext {
  processManager: WindowsProcessManager;
  isAdmin: boolean;
}

export function cmdTaskkill(ctx: TaskkillContext, args: string[]): string {
  if (args.length === 0) {
    return 'ERROR: Invalid syntax. A process name or PID must be specified.\n\nType "TASKKILL /?" for usage.';
  }

  let pid: number | null = null;
  let imageName = '';
  let force = false;
  let treeKill = false;
  const filters: Array<{ field: string; op: string; value: string }> = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase();
    if (flag === '/pid' && i + 1 < args.length) {
      pid = parseInt(args[++i], 10);
    } else if (flag === '/im' && i + 1 < args.length) {
      imageName = args[++i];
    } else if (flag === '/f') {
      force = true;
    } else if (flag === '/t') {
      treeKill = true;
    } else if (flag === '/fi' && i + 1 < args.length) {
      const f = parseFilter(args[++i]);
      if (f) filters.push(f);
    }
  }

  // /FI filter mode
  if (filters.length > 0) {
    return killByFilter(ctx, filters, force, treeKill);
  }

  if (pid !== null) {
    return killByPid(ctx, pid, force, treeKill);
  }

  if (imageName) {
    return killByImageName(ctx, imageName, force, treeKill);
  }

  return 'ERROR: Invalid syntax. A process name or PID must be specified.\n\nType "TASKKILL /?" for usage.';
}

function killByPid(ctx: TaskkillContext, pid: number, force: boolean, treeKill: boolean): string {
  if (treeKill) {
    const descendants = ctx.processManager.getDescendants(pid);
    const results: string[] = [];
    // Kill children first (deepest first)
    for (const child of descendants.reverse()) {
      const err = ctx.processManager.killProcess(child.pid, force, ctx.isAdmin);
      if (!err) {
        results.push(`SUCCESS: The process with PID ${child.pid} has been terminated.`);
      } else {
        results.push(err);
      }
    }
    const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
    if (err) return results.length > 0 ? results.join('\n') + '\n' + err : err;
    results.push(`SUCCESS: The process with PID ${pid} has been terminated.`);
    return results.join('\n');
  }

  if (!force) {
    // Without /F, taskkill sends WM_CLOSE (only works on windowed apps)
    const proc = ctx.processManager.getProcess(pid);
    if (!proc) return `ERROR: The process "${pid}" not found.`;
    if (!proc.windowTitle) {
      return `ERROR: The process with PID ${pid} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).`;
    }
  }

  const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
  if (err) return err;
  return `SUCCESS: The process with PID ${pid} has been terminated.`;
}

function killByImageName(ctx: TaskkillContext, imageName: string, force: boolean, treeKill: boolean): string {
  if (!force) {
    // Without /F, check if processes have windows
    const procs = ctx.processManager.getProcessesByName(imageName);
    if (procs.length === 0) return `ERROR: The process "${imageName}" not found.`;
    const noWindow = procs.filter(p => !p.windowTitle);
    if (noWindow.length === procs.length) {
      return `ERROR: The process "${imageName}" with PID ${procs[0].pid} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).`;
    }
  }

  return ctx.processManager.killByName(imageName, force, ctx.isAdmin, treeKill);
}

function killByFilter(
  ctx: TaskkillContext,
  filters: Array<{ field: string; op: string; value: string }>,
  force: boolean, treeKill: boolean
): string {
  let procs = ctx.processManager.getAllProcesses();
  for (const f of filters) {
    procs = applyFilter(procs, f);
  }

  if (procs.length === 0) {
    return 'INFO: No tasks running with the specified criteria.';
  }

  const results: string[] = [];
  for (const proc of procs) {
    if (treeKill) {
      const descendants = ctx.processManager.getDescendants(proc.pid);
      for (const child of descendants.reverse()) {
        const err = ctx.processManager.killProcess(child.pid, force, ctx.isAdmin);
        if (!err) results.push(`SUCCESS: The process with PID ${child.pid} has been terminated.`);
        else results.push(err);
      }
    }
    const err = ctx.processManager.killProcess(proc.pid, force, ctx.isAdmin);
    if (!err) results.push(`SUCCESS: The process with PID ${proc.pid} has been terminated.`);
    else results.push(err);
  }
  return results.join('\n');
}

function parseFilter(raw: string): { field: string; op: string; value: string } | null {
  const clean = raw.replace(/^["']|["']$/g, '');
  const match = clean.match(/^(\w+)\s+(eq|ne|gt|lt|ge|le)\s+(.+)$/i);
  if (!match) return null;
  return { field: match[1].toLowerCase(), op: match[2].toLowerCase(), value: match[3].trim() };
}

function applyFilter(
  procs: WindowsProcess[],
  filter: { field: string; op: string; value: string }
): WindowsProcess[] {
  return procs.filter(p => {
    switch (filter.field) {
      case 'imagename': {
        const name = p.name.toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? name === val : name !== val;
      }
      case 'pid': {
        const val = parseInt(filter.value, 10);
        switch (filter.op) {
          case 'eq': return p.pid === val;
          case 'ne': return p.pid !== val;
          case 'gt': return p.pid > val;
          case 'lt': return p.pid < val;
          default: return true;
        }
      }
      case 'status': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq'
          ? p.status.toLowerCase() === val
          : p.status.toLowerCase() !== val;
      }
      case 'memusage': {
        const val = parseInt(filter.value, 10);
        switch (filter.op) {
          case 'gt': return p.wsK > val;
          case 'lt': return p.wsK < val;
          case 'eq': return Math.floor(p.wsK) === val;
          default: return true;
        }
      }
      default: return true;
    }
  });
}
