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
import type { IIisProvider, WebsiteInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireIis(ctx: CmdletContext, cmdletName: string): IIisProvider {
  if (!ctx.providers.iis) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.iis;
}

function siteToPSObject(s: WebsiteInfo): Record<string, PSValue> {
  return { Name: s.name, PhysicalPath: s.physicalPath, Port: s.port, State: s.state };
}
function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

export class NewWebsiteCmdlet implements ICmdlet {
  readonly name = 'new-website';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'PhysicalPath', 'Port'] as const;

  execute(ctx: CmdletContext): PSValue {
    const iis = requireIis(ctx, 'New-Website');
    const name = nameOf(ctx);
    const physicalPath = psValueToString(ctx.named['physicalpath'] ?? '');
    const port = ctx.named['port'] !== undefined ? Number(psValueToString(ctx.named['port'])) : 80;
    if (!name || !physicalPath) {
      ctx.emitError('New-Website : Cannot process command because of one or more missing mandatory parameters: Name PhysicalPath.');
      return null;
    }
    const res = iis.newWebsite(name, physicalPath, port);
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
