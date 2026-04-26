/**
 * PowerShell service management cmdlets — matches real PowerShell 5.1 output exactly.
 *
 * Implements:
 *   - Get-Service [-Name <name>] [-DisplayName <pattern>] [-Status <status>]
 *   - Start-Service -Name <name> [-PassThru]
 *   - Stop-Service -Name <name> [-Force] [-PassThru]
 *   - Restart-Service -Name <name> [-Force] [-PassThru]
 *   - Set-Service -Name <name> [-StartupType ...] [-DisplayName ...] [-Description ...]
 *   - Suspend-Service -Name <name> [-PassThru]
 *   - Resume-Service -Name <name> [-PassThru]
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
  const displayName = params.get('displayname');
  const statusFilter = params.get('status');
  const include = params.get('include');
  const exclude = params.get('exclude');
  const computerName = params.get('computername');
  const dependentServices = params.has('dependentservices');
  const requiredServices = params.has('requiredservices');

  if (computerName) {
    return psError('Get-Service',
      'Get-Service : Remoting to a remote computer is not supported in this simulator.',
      'NotImplemented: (:) [Get-Service], NotSupportedException',
      'RemotingNotSupported,Microsoft.PowerShell.Commands.GetServiceCommand');
  }

  if (name) {
    // Support wildcard matching
    if (name.includes('*') || name.includes('?')) {
      const pattern = wildcardToRegex(name);
      let services = ctx.serviceManager.getAllServices().filter(s => pattern.test(s.name));
      if (statusFilter) {
        services = services.filter(s => s.state.toLowerCase() === statusFilter.toLowerCase());
      }
      if (exclude) {
        const excPattern = wildcardToRegex(exclude);
        services = services.filter(s => !excPattern.test(s.name));
      }
      if (services.length === 0) {
        return psError('Get-Service',
          `Cannot find any service with service name '${name}'.`,
          `ObjectNotFound: (${name}:String) [Get-Service], ServiceCommandException`,
          'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand');
      }
      return formatServiceTable(services);
    }

    const svc = ctx.serviceManager.getService(name);
    if (!svc) {
      return psError('Get-Service',
        `Cannot find any service with service name '${name}'.`,
        `ObjectNotFound: (${name}:String) [Get-Service], ServiceCommandException`,
        'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand');
    }

    if (dependentServices) {
      const deps = ctx.serviceManager.getDependents(svc.name);
      return formatServiceTable(deps);
    }

    if (requiredServices) {
      const reqs = svc.dependencies
        .map(d => ctx.serviceManager.getService(d))
        .filter((s): s is WindowsService => s !== undefined);
      return formatServiceTable(reqs);
    }

    // Append extended properties so property accessors (.Status, .StartType, etc.) work
    return formatServiceTable([svc]) + formatServiceExtended(svc);
  }

  if (displayName) {
    const pattern = wildcardToRegex(displayName);
    let services = ctx.serviceManager.getAllServices().filter(s => pattern.test(s.displayName));
    if (statusFilter) {
      services = services.filter(s => s.state.toLowerCase() === statusFilter.toLowerCase());
    }
    if (services.length === 0) {
      return psError('Get-Service',
        `Cannot find any service with service name '${displayName}'.`,
        `ObjectNotFound: (${displayName}:String) [Get-Service], ServiceCommandException`,
        'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand');
    }
    return formatServiceTable(services);
  }

  let services = ctx.serviceManager.getAllServices();
  if (statusFilter) {
    const lower = statusFilter.toLowerCase();
    services = services.filter(s => s.state.toLowerCase() === lower);
  }
  if (include) {
    const pattern = wildcardToRegex(include);
    services = services.filter(s => pattern.test(s.name));
  }
  if (exclude) {
    const pattern = wildcardToRegex(exclude);
    services = services.filter(s => !pattern.test(s.name));
  }

  return formatServiceTable(services);
}

// ─── Start-Service ────────────────────────────────────────────────

export function psStartService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const passThru = params.has('passthru');
  const whatIf = params.has('whatif');
  if (!name) {
    return psError('Start-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Start-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.StartServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Start-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Start-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.StartServiceCommand');
  }

  if (whatIf) {
    return `What if: Performing the operation "Start-Service" on target "${svc.displayName} (${svc.name})".`;
  }

  if (!ctx.isAdmin) {
    return psError('Start-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be started due to the following error: Cannot open ${svc.name} service on computer '.'.`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Start-Service], ServiceCommandException`,
      'CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand');
  }

  const err = ctx.serviceManager.startService(name, true);
  if (err) {
    if (err.includes('already running')) {
      return psError('Start-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be started due to the following error: An instance of the service is already running.`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Start-Service], ServiceCommandException`,
        'CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand');
    }
    if (err.includes('disabled')) {
      return psError('Start-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be started due to the following error: Cannot start service ${svc.name} on computer '.'.`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Start-Service], ServiceCommandException`,
        'CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand');
    }
    return `Start-Service : ${err}`;
  }

  ctx.processManager.onServiceStarted(svc.name, svc.processName);
  if (passThru) return formatServiceTable([svc]);
  return '';
}

// ─── Stop-Service ─────────────────────────────────────────────────

export function psStopService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const passThru = params.has('passthru');
  const force = params.has('force');
  const whatIf = params.has('whatif');
  if (!name) {
    return psError('Stop-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Stop-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.StopServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Stop-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Stop-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.StopServiceCommand');
  }

  if (whatIf) {
    return `What if: Performing the operation "Stop-Service" on target "${svc.displayName} (${svc.name})".`;
  }

  if (!ctx.isAdmin) {
    return psError('Stop-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be stopped due to the following error: Cannot open ${svc.name} service on computer '.'.`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Stop-Service], ServiceCommandException`,
      'CouldNotStopService,Microsoft.PowerShell.Commands.StopServiceCommand');
  }

  // With -Force, recursively stop all dependent services first
  if (force) {
    stopDependentsRecursively(ctx, svc.name);
  }

  const err = ctx.serviceManager.stopService(name, true);
  if (err) {
    if (err.includes('not been started')) {
      return psError('Stop-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be stopped due to the following error: The service has not been started.`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Stop-Service], ServiceCommandException`,
        'CouldNotStopService,Microsoft.PowerShell.Commands.StopServiceCommand');
    }
    if (err.includes('dependent')) {
      return psError('Stop-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be stopped due to the following error: ${err}`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Stop-Service], ServiceCommandException`,
        'CouldNotStopService,Microsoft.PowerShell.Commands.StopServiceCommand');
    }
    return `Stop-Service : ${err}`;
  }

  ctx.processManager.onServiceStopped(svc.name);
  if (passThru) return formatServiceTable([svc]);
  return '';
}

// ─── Restart-Service ──────────────────────────────────────────────

export function psRestartService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const passThru = params.has('passthru');
  const force = params.has('force');
  const whatIf = params.has('whatif');
  if (!name) {
    return psError('Restart-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Restart-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.RestartServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Restart-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Restart-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.RestartServiceCommand');
  }

  if (whatIf) {
    return `What if: Performing the operation "Restart-Service" on target "${svc.displayName} (${svc.name})".`;
  }

  if (!ctx.isAdmin) {
    return psError('Restart-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be restarted due to the following error: Cannot open ${svc.name} service on computer '.'.`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Restart-Service], ServiceCommandException`,
      'CouldNotRestartService,Microsoft.PowerShell.Commands.RestartServiceCommand');
  }

  // Stop if running (with -Force, stop dependents too)
  if (svc.state !== 'Stopped') {
    if (force) {
      stopDependentsRecursively(ctx, svc.name);
    }
    const stopErr = ctx.serviceManager.stopService(name, true);
    if (stopErr && !stopErr.includes('not been started')) {
      return psError('Restart-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be restarted due to the following error: ${stopErr}`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Restart-Service], ServiceCommandException`,
        'CouldNotRestartService,Microsoft.PowerShell.Commands.RestartServiceCommand');
    }
    ctx.processManager.onServiceStopped(svc.name);
  }

  // Start
  const startErr = ctx.serviceManager.startService(name, true);
  if (startErr) {
    return psError('Restart-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be restarted due to the following error: ${startErr}`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Restart-Service], ServiceCommandException`,
      'CouldNotRestartService,Microsoft.PowerShell.Commands.RestartServiceCommand');
  }
  ctx.processManager.onServiceStarted(svc.name, svc.processName);
  if (passThru) return formatServiceTable([svc]);
  return '';
}

// ─── Set-Service ──────────────────────────────────────────────────

export function psSetService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) {
    return psError('Set-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Set-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.SetServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Set-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Set-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.SetServiceCommand');
  }

  if (!ctx.isAdmin) {
    return psError('Set-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be configured due to the following error: Access is denied`,
      `PermissionDenied: (System.ServiceProcess.ServiceController:ServiceController) [Set-Service], ServiceCommandException`,
      'CouldNotSetService,Microsoft.PowerShell.Commands.SetServiceCommand');
  }

  if (params.has('startuptype')) {
    const typeMap: Record<string, ServiceStartType> = {
      automatic: 'Automatic', manual: 'Manual', disabled: 'Disabled',
      automaticdelayedstart: 'AutomaticDelayedStart',
      boot: 'Boot', system: 'System',
    };
    const st = typeMap[params.get('startuptype')!.toLowerCase()];
    if (!st) {
      return psError('Set-Service',
        `Cannot validate argument on parameter 'StartupType'. The argument "${params.get('startuptype')}" does not belong to the set "Automatic,AutomaticDelayedStart,Disabled,InvalidValue,Manual" specified by the ValidateSet attribute.`,
        `InvalidArgument: (:) [Set-Service], ParameterBindingValidationException`,
        'CannotValidateArgument,Microsoft.PowerShell.Commands.SetServiceCommand');
    }
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

  if (params.has('status')) {
    const status = params.get('status')!.toLowerCase();
    if (status === 'running') {
      const err = ctx.serviceManager.startService(name, true);
      if (err && !err.includes('already running')) return `Set-Service : ${err}`;
      ctx.processManager.onServiceStarted(svc.name, svc.processName);
    } else if (status === 'stopped') {
      const err = ctx.serviceManager.stopService(name, true);
      if (err && !err.includes('not been started')) return `Set-Service : ${err}`;
      ctx.processManager.onServiceStopped(svc.name);
    } else if (status === 'paused') {
      const err = ctx.serviceManager.pauseService(name, true);
      if (err) return `Set-Service : ${err}`;
    }
  }

  return '';
}

// ─── Suspend-Service / Resume-Service ─────────────────────────────

export function psSuspendService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const passThru = params.has('passthru');
  if (!name) {
    return psError('Suspend-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Suspend-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.SuspendServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Suspend-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Suspend-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.SuspendServiceCommand');
  }

  if (!ctx.isAdmin) {
    return psError('Suspend-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be suspended due to the following error: Cannot open ${svc.name} service on computer '.'.`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Suspend-Service], ServiceCommandException`,
      'CouldNotSuspendService,Microsoft.PowerShell.Commands.SuspendServiceCommand');
  }

  const err = ctx.serviceManager.pauseService(name, true);
  if (err) {
    if (err.includes('cannot be paused')) {
      return psError('Suspend-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be suspended because the service does not support being paused and continued.`,
        `CloseError: (System.ServiceProcess.ServiceController:ServiceController) [Suspend-Service], ServiceCommandException`,
        'CouldNotSuspendService,Microsoft.PowerShell.Commands.SuspendServiceCommand');
    }
    return `Suspend-Service : ${err}`;
  }
  if (passThru) return formatServiceTable([svc]);
  return '';
}

export function psResumeService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const passThru = params.has('passthru');
  if (!name) {
    return psError('Resume-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Resume-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.ResumeServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Resume-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Resume-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.ResumeServiceCommand');
  }

  if (!ctx.isAdmin) {
    return psError('Resume-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be resumed due to the following error: Cannot open ${svc.name} service on computer '.'.`,
      `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Resume-Service], ServiceCommandException`,
      'CouldNotResumeService,Microsoft.PowerShell.Commands.ResumeServiceCommand');
  }

  const err = ctx.serviceManager.resumeService(name, true);
  if (err) {
    if (err.includes('not paused')) {
      return psError('Resume-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be resumed because the service is not paused.`,
        `CloseError: (System.ServiceProcess.ServiceController:ServiceController) [Resume-Service], ServiceCommandException`,
        'CouldNotResumeService,Microsoft.PowerShell.Commands.ResumeServiceCommand');
    }
    return `Resume-Service : ${err}`;
  }
  if (passThru) return formatServiceTable([svc]);
  return '';
}

// ─── New-Service ──────────────────────────────────────────────────

export function psNewService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const binPath = params.get('binarypathname') || '';
  if (!name) {
    return psError('New-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [New-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.NewServiceCommand');
  }
  if (!binPath) {
    return psError('New-Service',
      `Cannot validate argument on parameter 'BinaryPathName'. The argument is null or empty.`,
      `InvalidArgument: (:) [New-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.NewServiceCommand');
  }

  if (!ctx.isAdmin) {
    return psError('New-Service',
      `Service '${name}' cannot be created due to the following error: Access is denied`,
      `PermissionDenied: (System.ServiceProcess.ServiceController:ServiceController) [New-Service], ServiceCommandException`,
      'CouldNotNewService,Microsoft.PowerShell.Commands.NewServiceCommand');
  }

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

  if (err) {
    if (err.includes('already exists')) {
      return psError('New-Service',
        `Service '${name}' cannot be created because a service with that name already exists.`,
        `PermissionDenied: (System.ServiceProcess.ServiceController:ServiceController) [New-Service], ServiceCommandException`,
        'CouldNotNewService,Microsoft.PowerShell.Commands.NewServiceCommand');
    }
    return `New-Service : ${err}`;
  }

  // Return table of the newly created service (matches real PS behavior)
  const svc = ctx.serviceManager.getService(name);
  if (svc) return formatServiceTable([svc]);
  return '';
}

// ─── Remove-Service ───────────────────────────────────────────────

export function psRemoveService(ctx: PSServiceContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) {
    return psError('Remove-Service',
      `Cannot validate argument on parameter 'Name'. The argument is null or empty.`,
      `InvalidArgument: (:) [Remove-Service], ParameterBindingValidationException`,
      'CannotValidateArgumentIsNullOrEmpty,Microsoft.PowerShell.Commands.RemoveServiceCommand');
  }

  const svc = ctx.serviceManager.getService(name);
  if (!svc) {
    return psError('Remove-Service',
      `Cannot find any service with service name '${name}'.`,
      `ObjectNotFound: (${name}:String) [Remove-Service], ServiceCommandException`,
      'NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.RemoveServiceCommand');
  }

  if (!ctx.isAdmin) {
    return psError('Remove-Service',
      `Service '${svc.displayName} (${svc.name})' cannot be removed due to the following error: Access is denied`,
      `PermissionDenied: (System.ServiceProcess.ServiceController:ServiceController) [Remove-Service], ServiceCommandException`,
      'CouldNotRemoveService,Microsoft.PowerShell.Commands.RemoveServiceCommand');
  }

  const err = ctx.serviceManager.deleteService(name, true);
  if (err) {
    if (err.includes('must be stopped')) {
      return psError('Remove-Service',
        `Service '${svc.displayName} (${svc.name})' cannot be removed because it is not stopped. Stop the service before removing it.`,
        `OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Remove-Service], ServiceCommandException`,
        'CouldNotRemoveService,Microsoft.PowerShell.Commands.RemoveServiceCommand');
    }
    return `Remove-Service : ${err}`;
  }
  return '';
}

// ─── Build dynamic service objects for pipeline ───────────────────

export function buildDynamicServiceObjects(ctx: PSServiceContext): Array<Record<string, unknown>> {
  return ctx.serviceManager.getAllServices().map(s => ({
    Status: s.state,
    Name: s.name,
    DisplayName: s.displayName,
    ServiceType: s.serviceType,
    StartType: s.startType,
    CanPauseAndContinue: s.canPauseAndContinue,
    CanShutdown: s.acceptsShutdown,
    DependentServices: ctx.serviceManager.getDependents(s.name).map(d => d.name),
    ServicesDependedOn: s.dependencies,
  }));
}

// ─── Helper: recursively stop dependents ─────────────────────────

function stopDependentsRecursively(ctx: PSServiceContext, serviceName: string): void {
  const deps = ctx.serviceManager.getRunningDependents(serviceName);
  for (const dep of deps) {
    // Recurse to stop this dependent's dependents first
    stopDependentsRecursively(ctx, dep.name);
    ctx.serviceManager.stopService(dep.name, true);
    ctx.processManager.onServiceStopped(dep.name);
  }
}

// ─── Formatting (matches real PowerShell 5.1 Get-Service output) ──
// Real PS5.1 columns: Status(7) + padding, Name(~25), DisplayName(remaining)
// Display names longer than ~38 chars get truncated with "..."

function formatServiceTable(services: WindowsService[]): string {
  const lines: string[] = [''];
  lines.push(
    'Status'.padEnd(10) +
    'Name'.padEnd(25) +
    'DisplayName'
  );
  lines.push(
    '------'.padEnd(10) +
    '----'.padEnd(25) +
    '-----------'
  );
  for (const s of services) {
    const displayName = s.displayName.length > 38
      ? s.displayName.substring(0, 35) + '...'
      : s.displayName;
    lines.push(
      s.state.padEnd(10) +
      s.name.padEnd(25) +
      displayName
    );
  }
  return lines.join('\n');
}

// ─── Extended property block (appended to single-service output) ──

function formatServiceExtended(svc: WindowsService): string {
  return [
    '',
    `Status      : ${svc.state}`,
    `Name        : ${svc.name}`,
    `DisplayName : ${svc.displayName}`,
    `StartType   : ${svc.startType}`,
    `ServiceType : ${svc.serviceType}`,
    `CanStop     : ${svc.state === 'Running'}`,
  ].join('\n');
}

// ─── Error formatting (matches real PS5.1 error output) ──────────

function psError(cmdlet: string, message: string, categoryInfo: string, errorId: string): string {
  return `${cmdlet} : ${message}\n    + CategoryInfo          : ${categoryInfo}\n    + FullyQualifiedErrorId : ${errorId}`;
}

// ─── Wildcard to regex ───────────────────────────────────────────

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i');
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
