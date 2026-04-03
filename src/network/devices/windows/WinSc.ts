/**
 * Windows sc (Service Control) command.
 *
 * Supports:
 *   - sc query [name]         — query service status
 *   - sc query type= all      — list all services
 *   - sc qc <name>            — query service configuration
 *   - sc start <name>         — start a service
 *   - sc stop <name>          — stop a service
 *   - sc config <name> start= auto|demand|disabled
 *   - sc create <name> binPath= "..." [DisplayName= "..."] [start= ...]
 *   - sc delete <name>        — delete a service
 */

import type { WindowsServiceManager } from './WindowsServiceManager';
import type { WindowsProcessManager } from './WindowsProcessManager';

export interface ScContext {
  serviceManager: WindowsServiceManager;
  processManager: WindowsProcessManager;
  isAdmin: boolean;
}

export function cmdSc(ctx: ScContext, args: string[]): string {
  if (args.length === 0) {
    return 'DESCRIPTION:\n        SC is a command line program used for communicating with the\n        Service Control Manager and services.\nUSAGE:\n        sc <server> [command] [service name] <option1> <option2>...';
  }

  const subCmd = args[0].toLowerCase();
  const subArgs = args.slice(1);

  switch (subCmd) {
    case 'query': return scQuery(ctx, subArgs);
    case 'qc':    return scQc(ctx, subArgs);
    case 'start': return scStart(ctx, subArgs);
    case 'stop':  return scStop(ctx, subArgs);
    case 'config': return scConfig(ctx, subArgs);
    case 'create': return scCreate(ctx, subArgs);
    case 'delete': return scDelete(ctx, subArgs);
    default:
      return `[SC] Unrecognized command "${subCmd}"`;
  }
}

function scQuery(ctx: ScContext, args: string[]): string {
  // sc query type= all — list all
  if (args.length >= 2 && args[0].toLowerCase() === 'type=' && args[1].toLowerCase() === 'all') {
    return listAllServices(ctx);
  }
  // Merge "type=" "all" patterns like "type=all"
  if (args.length >= 1 && args[0].toLowerCase().startsWith('type=')) {
    return listAllServices(ctx);
  }

  // sc query — list running services
  if (args.length === 0) {
    return listRunningServices(ctx);
  }

  // sc query <name>
  const svc = ctx.serviceManager.getService(args[0]);
  if (!svc) return `[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.`;
  return ctx.serviceManager.formatScQuery(svc);
}

function listRunningServices(ctx: ScContext): string {
  const running = ctx.serviceManager.getRunningServices();
  return running.map(s => ctx.serviceManager.formatScQuery(s)).join('\n\n');
}

function listAllServices(ctx: ScContext): string {
  const all = ctx.serviceManager.getAllServices();
  return all.map(s => ctx.serviceManager.formatScQuery(s)).join('\n\n');
}

function scQc(ctx: ScContext, args: string[]): string {
  if (args.length === 0) return '[SC] QueryServiceConfig FAILED: service name required.';
  const svc = ctx.serviceManager.getService(args[0]);
  if (!svc) return `[SC] OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.`;
  return ctx.serviceManager.formatScQc(svc);
}

function scStart(ctx: ScContext, args: string[]): string {
  if (args.length === 0) return '[SC] StartService: service name required.';
  const name = args[0];
  const err = ctx.serviceManager.startService(name, ctx.isAdmin);
  if (err) {
    if (err.includes('FAILED 1060')) return err;
    if (err.includes('disabled')) return `[SC] StartService FAILED 1058:\n\n${err}`;
    if (err.includes('already running')) return `[SC] StartService FAILED 1056:\n\n${err}`;
    return `[SC] StartService FAILED:\n\n${err}`;
  }

  // Spawn process for the service
  const svc = ctx.serviceManager.getService(name);
  if (svc) ctx.processManager.onServiceStarted(svc.name, svc.processName);

  // Return START_PENDING then RUNNING
  return `SERVICE_NAME: ${svc?.name ?? name}\n        STATE              : 2  START_PENDING`;
}

function scStop(ctx: ScContext, args: string[]): string {
  if (args.length === 0) return '[SC] ControlService: service name required.';
  const name = args[0];
  const svc = ctx.serviceManager.getService(name);
  const err = ctx.serviceManager.stopService(name, ctx.isAdmin);
  if (err) {
    if (err.includes('FAILED 1060')) return err;
    if (err.includes('not been started')) return `[SC] ControlService FAILED 1062:\n\n${err}`;
    if (err.includes('dependent') || err.includes('Cannot stop')) return `[SC] ControlService FAILED 1051:\n\n${err}`;
    return `[SC] ControlService FAILED:\n\n${err}`;
  }

  // Remove associated process
  if (svc) ctx.processManager.onServiceStopped(svc.name);

  return `SERVICE_NAME: ${svc?.name ?? name}\n        STATE              : 3  STOP_PENDING`;
}

function scConfig(ctx: ScContext, args: string[]): string {
  if (args.length < 2) return '[SC] ChangeServiceConfig: service name and option required.';

  const name = args[0];
  // Parse "start= auto" style arguments (sc uses space after =)
  const opts = parseScOptions(args.slice(1));

  if (opts.start) {
    const typeMap: Record<string, 'Automatic' | 'Manual' | 'Disabled'> = {
      auto: 'Automatic', demand: 'Manual', disabled: 'Disabled',
    };
    const startType = typeMap[opts.start.toLowerCase()];
    if (!startType) return `[SC] ChangeServiceConfig FAILED: Invalid start type "${opts.start}".`;
    const err = ctx.serviceManager.setStartType(name, startType, ctx.isAdmin);
    if (err) return `[SC] ChangeServiceConfig FAILED:\n\n${err}`;
  }

  return '[SC] ChangeServiceConfig SUCCESS';
}

function scCreate(ctx: ScContext, args: string[]): string {
  if (args.length < 2) return '[SC] CreateService: service name and binPath= required.';

  const name = args[0];
  const opts = parseScOptions(args.slice(1));

  if (!opts.binpath) return '[SC] CreateService FAILED: binPath= is required.';

  const startTypeMap: Record<string, 'Automatic' | 'Manual' | 'Disabled'> = {
    auto: 'Automatic', demand: 'Manual', disabled: 'Disabled',
  };

  const err = ctx.serviceManager.createService(name, {
    binaryPath: opts.binpath,
    displayName: opts.displayname || name,
    startType: opts.start ? startTypeMap[opts.start.toLowerCase()] : undefined,
  }, ctx.isAdmin);

  if (err) {
    if (err.includes('already exists')) return `[SC] CreateService FAILED 1073:\n\n${err}`;
    return `[SC] CreateService FAILED:\n\n${err}`;
  }

  return '[SC] CreateService SUCCESS';
}

function scDelete(ctx: ScContext, args: string[]): string {
  if (args.length === 0) return '[SC] DeleteService: service name required.';
  const name = args[0];
  const err = ctx.serviceManager.deleteService(name, ctx.isAdmin);
  if (err) {
    if (err.includes('Cannot delete')) return `[SC] DeleteService FAILED:\n\n${err}`;
    if (err.includes('must be stopped')) return `[SC] DeleteService FAILED 1072:\n\nThe service must be stopped before deleting.`;
    return `[SC] DeleteService FAILED:\n\n${err}`;
  }
  return '[SC] DeleteService SUCCESS';
}

/** Parse "key= value" pairs as used by sc.exe */
function parseScOptions(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    let key = args[i].toLowerCase();
    // Handle "binPath=" "value" and "binpath=value"
    if (key.endsWith('=')) {
      const val = args[i + 1] || '';
      result[key.slice(0, -1).replace(/\s/g, '')] = val.replace(/^["']|["']$/g, '');
      i++;
    } else if (key.includes('=')) {
      const [k, ...v] = key.split('=');
      result[k.replace(/\s/g, '')] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
  return result;
}
