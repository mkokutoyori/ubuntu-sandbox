/**
 * Windows net start / net stop commands — matches real net.exe output exactly.
 *
 * Supports:
 *   - net start            — list running services by display name
 *   - net start <service>  — start a service (by name or display name)
 *   - net stop <service>   — stop a service (by name or display name)
 */

import type { WindowsServiceManager } from './WindowsServiceManager';
import type { WindowsProcessManager } from './WindowsProcessManager';

export interface NetStartContext {
  serviceManager: WindowsServiceManager;
  processManager: WindowsProcessManager;
  isAdmin: boolean;
}

export function cmdNetStart(ctx: NetStartContext, args: string[]): string {
  if (args.length === 0) {
    return formatRunningServices(ctx);
  }

  const name = args.join(' ');
  const svc = resolveServiceName(ctx, name);
  if (!svc) return `The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.`;

  const err = ctx.serviceManager.startService(svc.name, ctx.isAdmin);
  if (err) {
    if (err.includes('Access is denied')) {
      return `System error 5 has occurred.\n\nAccess is denied.`;
    }
    if (err.includes('already running')) {
      return `The requested service has already been started.\n\nMore help is available by typing NET HELPMSG 2182.`;
    }
    if (err.includes('disabled')) {
      return `The service cannot be started, either because it is disabled or because\nit has no enabled devices associated with it.\n\nMore help is available by typing NET HELPMSG 3521.`;
    }
    return `System error.\n\n${err}`;
  }

  ctx.processManager.onServiceStarted(svc.name, svc.processName);
  return `The ${svc.displayName} service was started successfully.\n`;
}

export function cmdNetStop(ctx: NetStartContext, args: string[]): string {
  if (args.length === 0) {
    return 'The syntax of this command is:\n\nNET STOP\nservice';
  }

  const name = args.join(' ');
  const svc = resolveServiceName(ctx, name);
  if (!svc) return `The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.`;

  const err = ctx.serviceManager.stopService(svc.name, ctx.isAdmin);
  if (err) {
    if (err.includes('Access is denied')) {
      return `System error 5 has occurred.\n\nAccess is denied.`;
    }
    if (err.includes('not been started')) {
      return `The ${svc.displayName} service is not started.\n\nMore help is available by typing NET HELPMSG 3521.`;
    }
    if (err.includes('Cannot stop') || err.includes('dependent')) {
      return `The ${svc.displayName} service could not be stopped.\n\n${err}`;
    }
    return `System error.\n\n${err}`;
  }

  ctx.processManager.onServiceStopped(svc.name);
  return `The ${svc.displayName} service was stopped successfully.\n`;
}

function resolveServiceName(ctx: NetStartContext, name: string) {
  // Try exact name match first
  let svc = ctx.serviceManager.getService(name);
  if (svc) return svc;
  // Try display name match (case-insensitive)
  const all = ctx.serviceManager.getAllServices();
  return all.find(s => s.displayName.toLowerCase() === name.toLowerCase()) ?? null;
}

function formatRunningServices(ctx: NetStartContext): string {
  const running = ctx.serviceManager.getRunningServices();
  const lines: string[] = [];
  lines.push('These Windows services are started:\n');
  for (const svc of running.sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    lines.push(`   ${svc.displayName}`);
  }
  lines.push('\nThe command completed successfully.\n');
  return lines.join('\n');
}
