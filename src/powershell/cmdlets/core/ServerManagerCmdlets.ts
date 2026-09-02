/**
 * ServerManagerCmdlets — Get/Install/Uninstall-WindowsFeature
 * (PRD-Windows-Server.md §5 P2).
 *
 * Provider: ctx.providers.roles (IRoleProvider), populated only for a
 * `WindowsServer` device (`WindowsPC.getRoleManager()` returns null on a
 * client). When null, these throw the same "not recognized" signal every
 * other provider-backed cmdlet uses, which PowerShellSubShell.isFallbackError
 * catches and falls through to the legacy executor — which also doesn't
 * implement these cmdlets, so the user sees the real "term ... is not
 * recognized as the name of a cmdlet" message, exactly like a Windows
 * client that never had the ServerManager module installed.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IRoleProvider, WindowsFeatureInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireRoles(ctx: CmdletContext): IRoleProvider {
  if (!ctx.providers.roles) {
    throw new PSRuntimeError('Get-WindowsFeature is not recognized as the name of a cmdlet, function, script file, or operable program');
  }
  return ctx.providers.roles;
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function featureObject(f: WindowsFeatureInfo): Record<string, PSValue> {
  return {
    Name: f.name,
    DisplayName: f.displayName,
    Installed: f.installState === 'Installed',
    InstallState: f.installState,
    FeatureType: f.featureType,
  };
}

function featureObjects(features: WindowsFeatureInfo[]): PSValue {
  return features.map(featureObject) as PSValue;
}

function operationResult(success: boolean, changed: WindowsFeatureInfo[]): PSValue {
  return {
    Success: success,
    RestartNeeded: 'No',
    ExitCode: success ? 'Success' : 'Failed',
    FeatureResult: changed.map(c => c.displayName) as PSValue,
  } as PSValue;
}

// ── Get-WindowsFeature ───────────────────────────────────────────────────────

export class GetWindowsFeatureCmdlet implements ICmdlet {
  readonly name = 'get-windowsfeature';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const roles = requireRoles(ctx);
    const named = ctx.named['name'];
    const nameArg = named !== undefined ? psValueToString(named)
      : (ctx.positional.length > 0 ? psValueToString(ctx.positional[0]) : null);
    if (nameArg === null) return featureObjects(roles.listFeatures());

    if (/[*?]/.test(nameArg)) {
      const pat = wildcardRegex(nameArg);
      return featureObjects(roles.listFeatures().filter(f => pat.test(f.name) || pat.test(f.displayName)));
    }
    const f = roles.getFeature(nameArg);
    if (!f) {
      ctx.emitError(`Get-WindowsFeature : The specified feature name '${nameArg}' is not recognized.`);
      return null;
    }
    return featureObjects([f]);
  }
}

// ── Install-WindowsFeature ───────────────────────────────────────────────────

export class InstallWindowsFeatureCmdlet implements ICmdlet {
  readonly name = 'install-windowsfeature';
  readonly aliases = ['add-windowsfeature'] as const;
  readonly parameters = [
    'Name', 'IncludeManagementTools', 'IncludeAllSubFeature', 'Restart', 'WhatIf',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const roles = requireRoles(ctx);
    const named = ctx.named['name'];
    const nameArg = named !== undefined ? named
      : (ctx.positional.length > 0 ? ctx.positional[0] : null);
    if (nameArg === null) {
      ctx.emitError('Install-WindowsFeature : Cannot bind argument to parameter \'Name\' because it is an empty string.');
      return null;
    }
    const names = Array.isArray(nameArg) ? nameArg.map(psValueToString) : [psValueToString(nameArg)];
    const includeManagementTools = ctx.named['includemanagementtools'] === true;
    const whatIf = ctx.named['whatif'] === true;

    const changed: WindowsFeatureInfo[] = [];
    for (const n of names) {
      const res = roles.installFeature(n, { includeManagementTools, whatIf });
      if (!res.ok) {
        ctx.emitError(res.message);
        return null;
      }
      changed.push(...res.changed);
    }
    return operationResult(true, changed);
  }
}

// ── Uninstall-WindowsFeature ─────────────────────────────────────────────────

export class UninstallWindowsFeatureCmdlet implements ICmdlet {
  readonly name = 'uninstall-windowsfeature';
  readonly aliases = ['remove-windowsfeature'] as const;
  readonly parameters = ['Name', 'Restart'] as const;

  execute(ctx: CmdletContext): PSValue {
    const roles = requireRoles(ctx);
    const named = ctx.named['name'];
    const nameArg = named !== undefined ? named
      : (ctx.positional.length > 0 ? ctx.positional[0] : null);
    if (nameArg === null) {
      ctx.emitError('Uninstall-WindowsFeature : Cannot bind argument to parameter \'Name\' because it is an empty string.');
      return null;
    }
    const names = Array.isArray(nameArg) ? nameArg.map(psValueToString) : [psValueToString(nameArg)];

    const changed: WindowsFeatureInfo[] = [];
    for (const n of names) {
      const res = roles.uninstallFeature(n);
      if (!res.ok) {
        ctx.emitError(res.message);
        return null;
      }
      changed.push(...res.changed);
    }
    return operationResult(true, changed);
  }
}
