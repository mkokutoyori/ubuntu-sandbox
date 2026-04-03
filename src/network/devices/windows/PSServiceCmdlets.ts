/**
 * PowerShell service management cmdlets.
 *
 * Implements:
 *   - Get-Service [-Name <name>] [-Status <status>]
 *   - Start-Service -Name <name>
 *   - Stop-Service -Name <name>
 *   - Restart-Service -Name <name>
 *   - Set-Service -Name <name> [-StartupType ...] [-DisplayName ...] [-Description ...]
 *   - Suspend-Service -Name <name>
 *   - Resume-Service -Name <name>
 *   - New-Service -Name <name> -BinaryPathName <path> [-DisplayName ...] [-StartupType ...]
 *   - Remove-Service -Name <name>
 *
 * Uses WindowsServiceManager + WindowsProcessManager for lifecycle.
 */

import type { WindowsServiceManager, WindowsService, ServiceStartType } from './WindowsServiceManager';
import type { WindowsProcessManager } from './WindowsProcessManager';

export interface PSServiceContext {
  serviceManager: WindowsServiceManager;
  processManager: WindowsProcessManager;
  isAdmin: boolean;
}

// ─── Get-Service ──────────────────────────────────────────────────

export function psGetService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name');
  const statusFilter = params.get('status');

  if (name) {
    const svc = ctx.serviceManager.getService(name);
    if (!svc) return `Get-Service : Cannot find any service with service name '${name}'.`;
    return formatServiceTable([svc]);
  }

  let services = ctx.serviceManager.getAllServices();
  if (statusFilter) {
    const lower = statusFilter.toLowerCase();
    services = services.filter(s => s.state.toLowerCase() === lower);
  }

  return formatServiceTable(services);
}

// ─── Start-Service ────────────────────────────────────────────────

export function psStartService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Start-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Start-Service : Access is denied.`;

  const err = ctx.serviceManager.startService(name, true);
  if (err) return `Start-Service : ${err}`;

  const svc = ctx.serviceManager.getService(name);
  if (svc) ctx.processManager.onServiceStarted(svc.name, svc.processName);
  return '';
}

// ─── Stop-Service ─────────────────────────────────────────────────

export function psStopService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Stop-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Stop-Service : Access is denied.`;

  const svc = ctx.serviceManager.getService(name);
  const err = ctx.serviceManager.stopService(name, true);
  if (err) return `Stop-Service : ${err}`;

  if (svc) ctx.processManager.onServiceStopped(svc.name);
  return '';
}

// ─── Restart-Service ──────────────────────────────────────────────

export function psRestartService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Restart-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Restart-Service : Access is denied.`;

  const svc = ctx.serviceManager.getService(name);
  if (!svc) return `Restart-Service : Cannot find any service with service name '${name}'.`;

  // Stop if running (ignore errors for "not started")
  if (svc.state !== 'Stopped') {
    const stopErr = ctx.serviceManager.stopService(name, true);
    if (stopErr && !stopErr.includes('not been started')) return `Restart-Service : ${stopErr}`;
    ctx.processManager.onServiceStopped(svc.name);
  }

  // Start
  const startErr = ctx.serviceManager.startService(name, true);
  if (startErr) return `Restart-Service : ${startErr}`;
  ctx.processManager.onServiceStarted(svc.name, svc.processName);
  return '';
}

// ─── Set-Service ──────────────────────────────────────────────────

export function psSetService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Set-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Set-Service : Access is denied.`;

  if (params.has('startuptype')) {
    const typeMap: Record<string, ServiceStartType> = {
      automatic: 'Automatic', manual: 'Manual', disabled: 'Disabled',
      automaticdelayedstart: 'AutomaticDelayedStart',
    };
    const st = typeMap[params.get('startuptype')!.toLowerCase()];
    if (!st) return `Set-Service : Invalid startup type.`;
    const err = ctx.serviceManager.setStartType(name, st, true);
    if (err) return `Set-Service : ${err}`;
  }

  if (params.has('displayname')) {
    const err = ctx.serviceManager.setDisplayName(name, params.get('displayname')!, true);
    if (err) return `Set-Service : ${err}`;
  }

  if (params.has('description')) {
    const err = ctx.serviceManager.setDescription(name, params.get('description')!, true);
    if (err) return `Set-Service : ${err}`;
  }

  return '';
}

// ─── Suspend-Service / Resume-Service ─────────────────────────────

export function psSuspendService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Suspend-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Suspend-Service : Access is denied.`;

  const err = ctx.serviceManager.pauseService(name, true);
  if (err) return `Suspend-Service : ${err}`;
  return '';
}

export function psResumeService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Resume-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Resume-Service : Access is denied.`;

  const err = ctx.serviceManager.resumeService(name, true);
  if (err) return `Resume-Service : ${err}`;
  return '';
}

// ─── New-Service ──────────────────────────────────────────────────

export function psNewService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const binPath = params.get('binarypathname') || '';
  if (!name) return "New-Service : Cannot bind parameter 'Name'.";
  if (!binPath) return "New-Service : Cannot bind parameter 'BinaryPathName'.";
  if (!ctx.isAdmin) return `New-Service : Access is denied.`;

  const displayName = params.get('displayname');
  const description = params.get('description');
  const startupType = params.get('startuptype');

  const typeMap: Record<string, ServiceStartType> = {
    automatic: 'Automatic', manual: 'Manual', disabled: 'Disabled',
  };

  const err = ctx.serviceManager.createService(name, {
    binaryPath: binPath,
    displayName: displayName || undefined,
    description: description || undefined,
    startType: startupType ? typeMap[startupType.toLowerCase()] : undefined,
  }, true);

  if (err) return `New-Service : ${err}`;

  // Return table of the newly created service
  const svc = ctx.serviceManager.getService(name);
  if (svc) return formatServiceTable([svc]);
  return '';
}

// ─── Remove-Service ───────────────────────────────────────────────

export function psRemoveService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Remove-Service : Cannot bind parameter 'Name'.";
  if (!ctx.isAdmin) return `Remove-Service : Access is denied.`;

  const err = ctx.serviceManager.deleteService(name, true);
  if (err) return `Remove-Service : ${err}`;
  return '';
}

// ─── Build dynamic service objects for pipeline ───────────────────

export function buildDynamicServiceObjects(ctx: PSServiceContext): Array<Record<string, unknown>> {
  return ctx.serviceManager.getAllServices().map(s => ({
    Status: s.state,
    Name: s.name,
    DisplayName: s.displayName,
  }));
}

// ─── Formatting ───────────────────────────────────────────────────

function formatServiceTable(services: WindowsService[]): string {
  const lines: string[] = [''];
  lines.push('Status'.padEnd(10) + 'Name'.padEnd(24) + 'DisplayName');
  lines.push('------'.padEnd(10) + '----'.padEnd(24) + '-----------');
  for (const s of services) {
    lines.push(
      s.state.padEnd(10) + s.name.padEnd(24) + s.displayName
    );
  }
  return lines.join('\n');
}

// ─── Arg parser (same as other PS cmdlet files) ───────────────────

function parsePSArgs(args: string[]): Map<string, string> {
  const merged: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const tok of args) {
    if (inQuote) {
      buf += ' ' + tok;
      if (tok.endsWith('"') || tok.endsWith("'")) { inQuote = false; merged.push(buf); buf = ''; }
    } else if ((tok.startsWith('"') && !tok.endsWith('"')) || (tok.startsWith("'") && !tok.endsWith("'"))) {
      inQuote = true; buf = tok;
    } else {
      merged.push(tok);
    }
  }
  if (buf) merged.push(buf);

  const result = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].startsWith('-') && i + 1 < merged.length && !merged[i + 1].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), merged[i + 1].replace(/^["']|["']$/g, ''));
      i++;
    } else if (merged[i].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), 'true');
    } else {
      positional.push(merged[i].replace(/^["']|["']$/g, ''));
    }
  }
  if (positional.length > 0) result.set('_positional', positional[0]);
  return result;
}
