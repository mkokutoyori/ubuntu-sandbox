/**
 * Windows net start / net stop commands for service management.
 *
 * Supports:
 *   - net start            — list running services by display name
 *   - net start <service>  — start a service
 *   - net stop <service>   — stop a service
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

  // net start <serviceName>
  const name = args.join(' ');
  const svc = resolveServiceName(ctx, name);
  if (!svc) return `The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.`;

  const err = ctx.serviceManager.startService(svc.name, ctx.isAdmin);
  if (err) {
    if (err.includes('Access is denied')) return `System error.\n\nAccess is denied.`;
    return `System error.\n\n${err}`;
  }

  ctx.processManager.onServiceStarted(svc.name, svc.processName);
  return `The ${svc.displayName} service was started successfully.`;
}

export function cmdNetStop(ctx: NetStartContext, args: string[]): string {
  if (args.length === 0) {
    return 'The syntax of this command is:\n\nNET STOP service';
  }

  const name = args.join(' ');
  const svc = resolveServiceName(ctx, name);
  if (!svc) return `The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.`;

  const err = ctx.serviceManager.stopService(svc.name, ctx.isAdmin);
  if (err) {
    if (err.includes('Access is denied')) return `System error.\n\nAccess is denied.`;
    return `System error.\n\n${err}`;
  }

  ctx.processManager.onServiceStopped(svc.name);
  return `The ${svc.displayName} service was stopped successfully.`;
}

function resolveServiceName(ctx: NetStartContext, name: string) {
  // Try exact name match first
  let svc = ctx.serviceManager.getService(name);
  if (svc) return svc;
  // Try display name match
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
  lines.push(`\nThe command completed successfully.`);
  return lines.join('\n');
}
