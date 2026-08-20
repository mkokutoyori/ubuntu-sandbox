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

const DISPLAY_W = 56;
const NAME_W = 27;

function featureRow(f: WindowsFeatureInfo): string {
  const box = f.installState === 'Installed' ? '[X]' : '[ ]';
  return `${box} ${f.displayName}`.padEnd(DISPLAY_W) + f.name.padEnd(NAME_W) + f.installState;
}

function featureTable(features: WindowsFeatureInfo[]): string {
  const header = 'Display Name'.padEnd(DISPLAY_W) + 'Name'.padEnd(NAME_W) + 'Install State';
  const divider = '-'.repeat(header.length);
  return [header, divider, ...features.map(featureRow)].join('\n');
}

function resultTable(success: boolean, changed: WindowsFeatureInfo[]): string {
  const header = 'Success Restart Needed Exit Code      Feature Result';
  const divider = '------- -------------- ---------      --------------';
  const list = changed.length ? `{${changed.map(c => c.displayName).join(', ')}}` : '{}';
  const row = `${(success ? 'True' : 'False').padEnd(8)}No             ${(success ? 'Success' : 'Failed').padEnd(15)}${list}`;
  return [header, divider, row].join('\n');
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
    if (nameArg === null) return featureTable(roles.listFeatures());

    if (/[*?]/.test(nameArg)) {
      const pat = wildcardRegex(nameArg);
      return featureTable(roles.listFeatures().filter(f => pat.test(f.name) || pat.test(f.displayName)));
    }
    const f = roles.getFeature(nameArg);
    if (!f) {
      ctx.emitError(`Get-WindowsFeature : The specified feature name '${nameArg}' is not recognized.`);
      return null;
    }
    return featureTable([f]);
  }
}

// ── Install-WindowsFeature ───────────────────────────────────────────────────

export class InstallWindowsFeatureCmdlet implements ICmdlet {
  readonly name = 'install-windowsfeature';
  readonly aliases = ['add-windowsfeature'] as const;
  readonly parameters = ['Name', 'IncludeManagementTools', 'Restart'] as const;

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

    const changed: WindowsFeatureInfo[] = [];
    for (const n of names) {
      const res = roles.installFeature(n, { includeManagementTools });
      if (!res.ok) {
        ctx.emitError(res.message);
        return null;
      }
      changed.push(...res.changed);
    }
    return resultTable(true, changed);
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
    return resultTable(true, changed);
  }
}
