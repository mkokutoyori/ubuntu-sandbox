/**
 * WebAdminCmdlets — the minimal `WebAdministration` PowerShell surface
 * (PRD-Windows-Server.md §5 P11): `New-Website`, `Get-Website`,
 * `Start-Website`, `Stop-Website`, `Remove-Website`. `iisreset` is a
 * native EXE, not a cmdlet — dispatched from `executeCmdCommand`.
 *
 * Provider: ctx.providers.iis (IIisProvider), populated only for a
 * `WindowsServer` with the `Web-Server` role installed.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IIisProvider, WebsiteInfo, AppPoolInfo, WebModuleInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireIis(ctx: CmdletContext, cmdletName: string): IIisProvider {
  if (!ctx.providers.iis) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.iis;
}

function siteToPSObject(s: WebsiteInfo): Record<string, PSValue> {
  return {
    Name: s.name, PhysicalPath: s.physicalPath, Port: s.port, State: s.state,
    HttpsPort: s.httpsPort ?? null, CertificateThumbprint: s.certificateThumbprint ?? null,
    ApplicationPool: s.applicationPool,
  };
}

function appPoolToPSObject(p: AppPoolInfo): Record<string, PSValue> {
  return {
    Name: p.name, State: p.state, ManagedRuntimeVersion: p.managedRuntimeVersion, IdentityType: p.identityType,
    PeriodicRestartMinutes: p.periodicRestartMinutes, WorkerProcessCount: p.workerProcessCount, RecycleCount: p.recycleCount,
  };
}

function moduleToPSObject(m: WebModuleInfo): Record<string, PSValue> {
  return { Name: m.name, Type: m.type };
}
function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

export class NewWebsiteCmdlet implements ICmdlet {
  readonly name = 'new-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'PhysicalPath', 'Port', 'ApplicationPool'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'New-Website');
    const name = nameOf(ctx);
    const physicalPath = psValueToString(ctx.named['physicalpath'] ?? '');
    const port = ctx.named['port'] !== undefined ? Number(psValueToString(ctx.named['port'])) : 80;
    if (!name || !physicalPath) {
      ctx.emitError('New-Website : Cannot process command because of one or more missing mandatory parameters: Name PhysicalPath.');
      return null;
    }
    const applicationPool = ctx.named['applicationpool'] !== undefined ? psValueToString(ctx.named['applicationpool']) : undefined;
    const res = iis.newWebsite(name, physicalPath, port, applicationPool);
    if (!res.ok) { ctx.emitError(`New-Website : ${res.message}`); return null; }
    const site = iis.getWebsite(name);
    return site ? siteToPSObject(site) : null;
  }
}

export class GetWebsiteCmdlet implements ICmdlet {
  readonly name = 'get-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Get-Website');
    const name = nameOf(ctx);
    if (name) {
      const site = iis.getWebsite(name);
      if (!site) { ctx.emitError(`Get-Website : No website exists with the name "${name}".`); return null; }
      return siteToPSObject(site);
    }
    return iis.listWebsites().map(siteToPSObject);
  }
}

export class StartWebsiteCmdlet implements ICmdlet {
  readonly name = 'start-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Start-Website');
    const res = iis.startWebsite(nameOf(ctx));
    if (!res.ok) { ctx.emitError(`Start-Website : ${res.message}`); return null; }
    return null;
  }
}

export class StopWebsiteCmdlet implements ICmdlet {
  readonly name = 'stop-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Stop-Website');
    const res = iis.stopWebsite(nameOf(ctx));
    if (!res.ok) { ctx.emitError(`Stop-Website : ${res.message}`); return null; }
    return null;
  }
}

// ── New-WebBinding (PRD-Windows-Server-Advanced.md §5 P14) ──────────────────

export class NewWebBindingCmdlet implements ICmdlet {
  readonly name = 'new-webbinding';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Protocol', 'Port', 'CertificateHash'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'New-WebBinding');
    const name = nameOf(ctx);
    if (!name) {
      ctx.emitError('New-WebBinding : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const protocolRaw = psValueToString(ctx.named['protocol'] ?? 'http').toLowerCase();
    const protocol = protocolRaw === 'https' ? 'https' : 'http';
    const port = ctx.named['port'] !== undefined ? Number(psValueToString(ctx.named['port'])) : (protocol === 'https' ? 443 : 80);
    const certificateHash = ctx.named['certificatehash'] !== undefined ? psValueToString(ctx.named['certificatehash']) : undefined;
    const res = iis.newBinding(name, protocol, port, certificateHash);
    if (!res.ok) { ctx.emitError(`New-WebBinding : ${res.message}`); return null; }
    const site = iis.getWebsite(name);
    return site ? siteToPSObject(site) : null;
  }
}

export class RemoveWebsiteCmdlet implements ICmdlet {
  readonly name = 'remove-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Remove-Website');
    const res = iis.removeWebsite(nameOf(ctx));
    if (!res.ok) { ctx.emitError(`Remove-Website : ${res.message}`); return null; }
    return null;
  }
}

// ── App pools (PRD-Windows-Server-Advanced.md §5 P15) ───────────────────────

export class NewWebAppPoolCmdlet implements ICmdlet {
  readonly name = 'new-webapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ManagedRuntimeVersion'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'New-WebAppPool');
    const name = nameOf(ctx);
    if (!name) {
      ctx.emitError('New-WebAppPool : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const managedRuntimeVersion = ctx.named['managedruntimeversion'] !== undefined ? psValueToString(ctx.named['managedruntimeversion']) : undefined;
    const res = iis.newAppPool(name, { managedRuntimeVersion });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const pool = iis.getAppPool(name);
    return pool ? appPoolToPSObject(pool) : null;
  }
}

export class GetIISAppPoolCmdlet implements ICmdlet {
  readonly name = 'get-iisapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;
  readonly displayName = 'Get-IISAppPool';

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Get-IISAppPool');
    const name = nameOf(ctx);
    if (name) {
      const pool = iis.getAppPool(name);
      if (!pool) { ctx.emitError(`Get-IISAppPool : An application pool named "${name}" does not exist.`); return null; }
      return appPoolToPSObject(pool);
    }
    return iis.listAppPools().map(appPoolToPSObject);
  }
}

export class RemoveWebAppPoolCmdlet implements ICmdlet {
  readonly name = 'remove-webapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Remove-WebAppPool');
    const res = iis.removeAppPool(nameOf(ctx));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class StartWebAppPoolCmdlet implements ICmdlet {
  readonly name = 'start-webapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Start-WebAppPool');
    const res = iis.startAppPool(nameOf(ctx));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class StopWebAppPoolCmdlet implements ICmdlet {
  readonly name = 'stop-webapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Stop-WebAppPool');
    const res = iis.stopAppPool(nameOf(ctx));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class RestartWebAppPoolCmdlet implements ICmdlet {
  readonly name = 'restart-webapppool';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Restart-WebAppPool');
    const res = iis.recycleAppPool(nameOf(ctx));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Global modules (PRD-Windows-Server-Advanced.md §5 P15) ──────────────────

export class GetWebGlobalModuleCmdlet implements ICmdlet {
  readonly name = 'get-webglobalmodule';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'Get-WebGlobalModule');
    const name = nameOf(ctx);
    const modules = iis.listGlobalModules();
    if (name) {
      const mod = modules.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (!mod) { ctx.emitError(`Get-WebGlobalModule : Cannot find a module with name: '${name}'.`); return null; }
      return moduleToPSObject(mod);
    }
    return modules.map(moduleToPSObject);
  }
}
