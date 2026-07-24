import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IExchangeProvider, ExchangeServerInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireExchange(ctx: CmdletContext, cmdletName: string): IExchangeProvider {
  if (!ctx.providers.exchange) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.exchange;
}

function serverToPSObject(s: ExchangeServerInfo): Record<string, PSValue> {
  return {
    Name: s.hostname,
    Fqdn: s.hostname,
    ServerRole: s.roles.join(', '),
    OrganizationName: s.organizationName,
    Edition: 'Enterprise',
  };
}

function rolesFrom(raw: PSValue): string[] {
  if (raw === undefined || raw === null) return ['Mailbox'];
  if (Array.isArray(raw)) return raw.map(psValueToString);
  return [psValueToString(raw)];
}

export class InstallExchangeServerCmdlet implements ICmdlet {
  readonly name = 'install-exchangeserver';
  readonly displayName = 'Install-ExchangeServer';
  readonly aliases = [] as const;
  readonly parameters = ['Roles', 'OrganizationName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Install-ExchangeServer');
    const organizationName = psValueToString(ctx.named['organizationname'] ?? '');
    if (!organizationName) {
      ctx.emitError('Install-ExchangeServer : Cannot process command because of one or more missing mandatory parameters: OrganizationName.');
      return null;
    }
    const roles = rolesFrom(ctx.named['roles']);
    const res = exchange.installExchangeServer(organizationName, roles);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: 'Success.', Roles: roles, OrganizationName: organizationName } as Record<string, PSValue>;
  }
}

export class GetExchangeServerCmdlet implements ICmdlet {
  readonly name = 'get-exchangeserver';
  readonly displayName = 'Get-ExchangeServer';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-ExchangeServer');
    const identity = ctx.named['identity'] !== undefined
      ? psValueToString(ctx.named['identity'])
      : ctx.positional[0] !== undefined ? psValueToString(ctx.positional[0]) : undefined;

    if (identity) {
      const server = exchange.getExchangeServer(identity);
      if (!server) {
        ctx.emitError(`Get-ExchangeServer : The operation couldn't be performed because object '${identity}' couldn't be found on 'Configuration'.`);
        return null;
      }
      return serverToPSObject(server);
    }

    const servers = exchange.listExchangeServers().map(serverToPSObject);
    return servers.length === 1 ? servers[0] : servers;
  }
}
