/**
 * Windows taskkill command — terminate processes by PID or image name.
 *
 * Supports:
 *   - taskkill /PID <pid> [/F]
 *   - taskkill /IM <name> [/F] [/T]
 *   - /F = force termination
 *   - /T = tree kill (terminate child processes)
 */

import type { WindowsProcessManager } from './WindowsProcessManager';

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
    }
  }

  if (pid !== null) {
    if (treeKill) {
      const descendants = ctx.processManager.getDescendants(pid);
      const results: string[] = [];
      for (const child of descendants.reverse()) {
        const err = ctx.processManager.killProcess(child.pid, force, ctx.isAdmin);
        if (!err) results.push(`SUCCESS: The process with PID ${child.pid} has been terminated.`);
      }
      const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
      if (err) return err;
      results.push(`SUCCESS: The process with PID ${pid} has been terminated.`);
      return results.join('\n');
    }

    const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
    if (err) return err;
    return `SUCCESS: The process with PID ${pid} has been terminated.`;
  }

  if (imageName) {
    return ctx.processManager.killByName(imageName, force, ctx.isAdmin, treeKill);
  }

  return 'ERROR: Invalid syntax. A process name or PID must be specified.';
}
