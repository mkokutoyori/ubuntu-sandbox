/**
 * ServiceCmdlets — Get/Start/Stop/Restart/Set/Suspend/Resume/New/Remove-Service.
 *
 * All routing goes through `ctx.providers.services` so the same cmdlet works
 * against a real WindowsPC (via `WindowsPSProviders`) or against any other
 * IServiceProvider implementation.
 *
 * Cmdlets emit ServiceInfo records (already shaped like the columns Get-Service
 * shows: Status / Name / DisplayName / ServiceType / StartType / …) so
 * downstream Sort-Object / Where-Object / Format-Table work the same way as
 * for any other PSObject pipeline.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import type { ServiceInfo, IServiceProvider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { wildcardToRegex } from '@/powershell/runtime/PSWildcard';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Compile a PowerShell-style wildcard (`*`, `?`) into a case-insensitive regex. */
/**
 * Map PowerShell's user-visible `-StartupType` values onto the canonical
 * `ServiceStartType` enum the device service manager understands. Mirrors
 * the legacy executor's typeMap so cmd and PS end up with identical state.
 */
function normalizeStartupType(raw: string): string {
  const k = raw.toLowerCase();
  if (k === 'automatic')              return 'Automatic';
  if (k === 'automaticdelayedstart')  return 'AutomaticDelayedStart';
  if (k === 'manual' || k === 'demand') return 'Manual';
  if (k === 'disabled')               return 'Disabled';
  if (k === 'boot')                   return 'Boot';
  if (k === 'system')                 return 'System';
  return raw;
}

function requireServices(ctx: CmdletContext): IServiceProvider {
  if (!ctx.providers.services) {
    // PowerShellSubShell.isFallbackError catches "not recognized" and falls
    // back to the legacy executor, so this becomes invisible to end users
    // running the standalone PSInterpreter.
    throw new PSRuntimeError(commandNotFoundMessage('Get-Service'));
  }
  return ctx.providers.services;
}

/**
 * Resolve a service name from named param `-Name`, positional, or piped
 * input. Pipe input may be a string, a ServiceInfo, or a list of either.
 */
function pickServiceName(ctx: CmdletContext): string | string[] | null {
  const named = ctx.named['name'];
  if (named !== undefined && named !== null && named !== '') {
    return Array.isArray(named) ? named.map(psValueToString) : psValueToString(named);
  }
  if (ctx.positional.length > 0) {
    const p = ctx.positional[0];
    return Array.isArray(p) ? p.map(psValueToString) : psValueToString(p);
  }
  if (ctx.pipeInput !== null && ctx.pipeInput !== undefined) {
    if (Array.isArray(ctx.pipeInput)) {
      return ctx.pipeInput.map(item => extractName(item));
    }
    return extractName(ctx.pipeInput);
  }
  return null;
}

function extractName(item: PSValue): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const rec = item as Record<string, PSValue>;
    return psValueToString(rec['Name'] ?? rec['name'] ?? '');
  }
  return psValueToString(item);
}

/**
 * Re-shape a ServiceInfo into the PS-style PSObject Get-Service publishes.
 * Capitalised property names matter — downstream `Group-Object Status`,
 * `Where-Object { $_.Status -eq "Running" }`, formatters etc. all key on
 * the canonical names rather than the TypeScript-friendly lowercase ones.
 */
function toPSObject(s: ServiceInfo): Record<string, PSValue> {
  return {
    Status:              s.state,
    Name:                s.name,
    DisplayName:         s.displayName,
    Description:         s.description,
    ServiceType:         s.serviceType,
    StartType:           s.startType,
    BinaryPath:          s.binaryPath,
    Account:             s.account,
    DependentServices:   [...s.dependents] as PSValue,
    ServicesDependedOn:  [...s.dependencies] as PSValue,
    CanPauseAndContinue: s.canPauseAndContinue,
  };
}

// Helper: pipeline-friendly conversion. We RETURN an array (to feed downstream
// stages like `| Group-Object Status`) rather than calling ctx.emit() per item,
// because emit() in this runtime appends straight to outputLines and bypasses
// the pipeline.
function asPSObjects(list: ServiceInfo[]): PSValue {
  return list.map(toPSObject) as PSValue;
}

// ── Get-Service / gsv ──────────────────────────────────────────────────────

export class GetServiceCmdlet implements ICmdlet {
  readonly name = 'get-service';
  readonly aliases = ['gsv'] as const;
  readonly parameters = ['Name', 'DisplayName', 'Include', 'Exclude', 'InputObject', 'DependentServices', 'RequiredServices'] as const;

  execute(ctx: CmdletContext): PSValue {
    const svc = requireServices(ctx);
    // -DisplayName filter (wildcard-capable). Applied before -Name so the
    // two parameters compose cleanly when both are present.
    const displayPattern = ctx.named['displayname'] !== undefined
      ? psValueToString(ctx.named['displayname']) : null;
    if (displayPattern !== null) {
      const pat = wildcardToRegex(displayPattern);
      return asPSObjects(svc.listServices().filter(s => pat.test(s.displayName)));
    }
    const name = pickServiceName(ctx);
    if (name === null) return asPSObjects(svc.listServices());

    const names = Array.isArray(name) ? name : [name];
    const out: ServiceInfo[] = [];
    for (const n of names) {
      // Wildcard support — `Get-Service "spo*"` filters by name + display.
      if (/[*?]/.test(n)) {
        const pat = new RegExp('^' + n.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        let matched = 0;
        for (const s of svc.listServices()) {
          if (pat.test(s.name) || pat.test(s.displayName)) { out.push(s); matched++; }
        }
        if (matched === 0) {
          ctx.emitError(`Cannot find any service with service name '${n}'.`);
        }
        continue;
      }
      const found = svc.getService(n);
      if (found) out.push(found);
      else ctx.emitError(`Cannot find any service with service name '${n}'.`);
    }
    return asPSObjects(out);
  }
}

// ── Start / Stop / Restart / Suspend / Resume ──────────────────────────────

abstract class ServiceActionCmdlet implements ICmdlet {
  abstract readonly name: string;
  abstract readonly aliases: readonly string[];
  readonly parameters = ['Name', 'DisplayName', 'InputObject', 'Force', 'PassThru'] as const;
  protected abstract act(svc: IServiceProvider, name: string, force: boolean): string;

  execute(ctx: CmdletContext): PSValue {
    const svc = requireServices(ctx);
    const name = pickServiceName(ctx);
    if (name === null) {
      ctx.emitError(`Cannot bind ${this.name}: missing -Name`);
      return null;
    }
    const force = ctx.named['force'] === true;
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const msg = this.act(svc, n, force);
      if (msg) ctx.emit(msg);
    }
    return null;
  }
}

export class StartServiceCmdlet extends ServiceActionCmdlet {
  readonly name = 'start-service';
  readonly aliases = ['sasv'] as const;
  protected act(svc: IServiceProvider, name: string) { return svc.startService(name); }
}

export class StopServiceCmdlet extends ServiceActionCmdlet {
  readonly name = 'stop-service';
  readonly aliases = ['spsv'] as const;
  protected act(svc: IServiceProvider, name: string, force: boolean) { return svc.stopService(name, force); }
}

export class RestartServiceCmdlet extends ServiceActionCmdlet {
  readonly name = 'restart-service';
  readonly aliases = [] as const;
  protected act(svc: IServiceProvider, name: string, force: boolean) { return svc.restartService(name, force); }
}

export class SuspendServiceCmdlet extends ServiceActionCmdlet {
  readonly name = 'suspend-service';
  readonly aliases = [] as const;
  protected act(svc: IServiceProvider, name: string) { return svc.suspendService(name); }
}

export class ResumeServiceCmdlet extends ServiceActionCmdlet {
  readonly name = 'resume-service';
  readonly aliases = [] as const;
  protected act(svc: IServiceProvider, name: string) { return svc.resumeService(name); }
}

// ── Set-Service ────────────────────────────────────────────────────────────

export class SetServiceCmdlet implements ICmdlet {
  readonly name = 'set-service';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'DisplayName', 'Description', 'StartupType', 'Status', 'Credential', 'PassThru'] as const;

  execute(ctx: CmdletContext): PSValue {
    const svc = requireServices(ctx);
    const name = pickServiceName(ctx);
    if (name === null) {
      ctx.emitError('Cannot bind Set-Service: missing -Name');
      return null;
    }
    const opts: { startType?: string; description?: string; displayName?: string; status?: string } = {};
    // Set-Service exposes the parameter as `-StartupType`; lower-case key in
    // ctx.named is therefore `startuptype` (matches the real PowerShell name).
    // Accept the historical alias `starttype` too.
    const startupRaw = ctx.named['startuptype'] ?? ctx.named['starttype'];
    if (startupRaw !== undefined)              opts.startType   = normalizeStartupType(psValueToString(startupRaw));
    if (ctx.named['description'] !== undefined) opts.description = psValueToString(ctx.named['description']);
    if (ctx.named['displayname'] !== undefined) opts.displayName = psValueToString(ctx.named['displayname']);
    if (ctx.named['status']      !== undefined) opts.status      = psValueToString(ctx.named['status']);

    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const msg = svc.setService(n, opts);
      if (msg) ctx.emit(msg);
    }
    return null;
  }
}

// ── New-Service / Remove-Service ───────────────────────────────────────────

export class NewServiceCmdlet implements ICmdlet {
  readonly name = 'new-service';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'BinaryPathName', 'DisplayName', 'Description', 'StartupType', 'DependsOn', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const svc = requireServices(ctx);
    const name        = psValueToString(ctx.named['name']        ?? ctx.positional[0] ?? '');
    const binaryPath  = psValueToString(ctx.named['binarypathname'] ?? ctx.named['binarypath'] ?? ctx.positional[1] ?? '');
    if (!name || !binaryPath) {
      ctx.emitError('New-Service requires -Name and -BinaryPathName');
      return null;
    }
    const startupRaw = ctx.named['startuptype'] ?? ctx.named['starttype'];
    const dependsOnRaw = ctx.named['dependson'];
    const msg = svc.newService(name, {
      binaryPath,
      displayName: ctx.named['displayname'] ? psValueToString(ctx.named['displayname']) : undefined,
      startType:   startupRaw !== undefined ? normalizeStartupType(psValueToString(startupRaw)) : undefined,
      description: ctx.named['description'] ? psValueToString(ctx.named['description']) : undefined,
      dependsOn:   dependsOnRaw !== undefined
        ? (Array.isArray(dependsOnRaw) ? dependsOnRaw.map(psValueToString) : [psValueToString(dependsOnRaw)])
        : undefined,
    });
    if (msg) ctx.emit(msg);
    return null;
  }
}

export class RemoveServiceCmdlet implements ICmdlet {
  readonly name = 'remove-service';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const svc = requireServices(ctx);
    const name = pickServiceName(ctx);
    if (name === null) {
      ctx.emitError('Remove-Service requires -Name');
      return null;
    }
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const msg = svc.removeService(n);
      if (msg) ctx.emit(msg);
    }
    return null;
  }
}

// ── Register-WmiEvent ──────────────────────────────────────────────────────
//
// Simulates the `SELECT * FROM __InstanceModificationEvent … WHERE
// TargetInstance ISA 'Win32_Service' AND TargetInstance.Name = '<name>'`
// pattern: real WMI polls at the WITHIN interval, but since every state
// change already flows through the service manager, we deliver the -Action
// synchronously the instant it happens — indistinguishable from a WITHIN=2s
// poll catching it, and with zero risk of missing a fast transition.

const WMI_TARGET_NAME_RE = /TargetInstance\.Name\s*=\s*['"]([^'"]+)['"]/i;
const WMI_CLASS_RE = /ISA\s+['"]([^'"]+)['"]/i;

export class RegisterWmiEventCmdlet implements ICmdlet {
  readonly name = 'register-wmievent';
  readonly aliases = [] as const;
  readonly parameters = ['Query', 'Class', 'Action', 'SourceIdentifier', 'Timeout'] as const;

  execute(ctx: CmdletContext): PSValue {
    const query = psValueToString(ctx.named['query'] ?? '');
    const action = ctx.named['action'] as PSScriptBlock | undefined;
    if (!action) {
      ctx.emitError('Register-WmiEvent requires -Action in this simulator (synchronous delivery, no Wait-Event queue)');
      return null;
    }
    const classMatch = WMI_CLASS_RE.exec(query);
    const wmiClass = classMatch ? classMatch[1] : psValueToString(ctx.named['class'] ?? '');
    if (wmiClass.toLowerCase() !== 'win32_service') {
      ctx.emitError(`Register-WmiEvent: class '${wmiClass}' is not supported in this simulator (only Win32_Service instance modification)`);
      return null;
    }
    const nameMatch = WMI_TARGET_NAME_RE.exec(query);
    if (!nameMatch) {
      ctx.emitError('Register-WmiEvent: could not find "TargetInstance.Name = \'<service>\'" in -Query');
      return null;
    }
    const serviceName = nameMatch[1];
    const svc = requireServices(ctx);

    const runtime = ctx.runtime;
    const env = ctx.env;
    const subId = svc.registerInstanceWatcher(serviceName, (evt) => {
      const eventObj = {
        SourceEventArgs: {
          NewEvent: {
            TargetInstance: {
              Name: serviceName,
              State: evt.newState,
              PreviousState: evt.previousState,
            },
          },
        },
        TimeGenerated: evt.timestamp,
      } as Record<string, PSValue>;
      runtime.setVariable('Event', eventObj);
      runtime.invokeScriptBlock(action, {}, [], env, null);
    });
    return { Id: 1, SourceIdentifier: psValueToString(ctx.named['sourceidentifier'] ?? subId) } as Record<string, PSValue>;
  }
}
