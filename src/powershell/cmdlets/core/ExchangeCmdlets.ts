import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IExchangeProvider, ExchangeServerInfo, MailboxInfo, MailboxStatisticsInfo, DistributionGroupInfo } from '@/powershell/providers/PSProviders';
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

function identityFrom(ctx: CmdletContext): string {
  return psValueToString(ctx.named['identity'] ?? ctx.positional[0] ?? '');
}

function securePasswordFrom(ctx: CmdletContext, key: string): string | undefined {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'SecureString' in (raw as Record<string, PSValue>)) {
    return psValueToString((raw as Record<string, PSValue>).SecureString);
  }
  return psValueToString(raw);
}

function parseQuotaBytes(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'unlimited') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB)?$/i.exec(trimmed);
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const multiplier = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
  return Math.round(value * multiplier);
}

function mailboxToPSObject(m: MailboxInfo): Record<string, PSValue> {
  return {
    Identity: m.identity,
    Name: m.identity,
    PrimarySmtpAddress: m.primarySmtpAddress,
    EmailAddresses: m.proxyAddresses.join(', '),
    ProhibitSendReceiveQuota: m.quotaBytes === null ? 'Unlimited' : String(m.quotaBytes),
  };
}

function statisticsToPSObject(s: MailboxStatisticsInfo): Record<string, PSValue> {
  const folderCounts: Record<string, PSValue> = {};
  for (const [folder, count] of Object.entries(s.folderItemCounts)) {
    folderCounts[`${folder.replace(/\s+/g, '')}Count`] = count;
  }
  return {
    Identity: s.identity,
    ItemCount: s.itemCount,
    TotalItemSize: s.totalItemSize,
    ...folderCounts,
  };
}

export class EnableMailboxCmdlet implements ICmdlet {
  readonly name = 'enable-mailbox';
  readonly displayName = 'Enable-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Enable-Mailbox');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Enable-Mailbox : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.enableMailbox(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const mailbox = exchange.getMailbox(identity);
    return mailbox ? mailboxToPSObject(mailbox) : null;
  }
}

export class NewMailboxCmdlet implements ICmdlet {
  readonly name = 'new-mailbox';
  readonly displayName = 'New-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Password'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-Mailbox');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-Mailbox : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const password = securePasswordFrom(ctx, 'password');
    if (!password) { ctx.emitError('New-Mailbox : Cannot process command because of one or more missing mandatory parameters: Password.'); return null; }
    const res = exchange.newMailbox(name, password);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const mailbox = exchange.getMailbox(name);
    return mailbox ? mailboxToPSObject(mailbox) : null;
  }
}

export class GetMailboxCmdlet implements ICmdlet {
  readonly name = 'get-mailbox';
  readonly displayName = 'Get-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-Mailbox');
    const identity = identityFrom(ctx);
    if (identity) {
      const mailbox = exchange.getMailbox(identity);
      if (!mailbox) {
        ctx.emitError(`Get-Mailbox : The operation couldn't be performed because object '${identity}' couldn't be found.`);
        return null;
      }
      return mailboxToPSObject(mailbox);
    }
    const mailboxes = exchange.listMailboxes().map(mailboxToPSObject);
    return mailboxes.length === 1 ? mailboxes[0] : mailboxes;
  }
}

export class SetMailboxCmdlet implements ICmdlet {
  readonly name = 'set-mailbox';
  readonly displayName = 'Set-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'ProhibitSendReceiveQuota'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Set-Mailbox');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Set-Mailbox : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    if (ctx.named['prohibitsendreceivequota'] !== undefined) {
      const raw = psValueToString(ctx.named['prohibitsendreceivequota']);
      const quotaBytes = parseQuotaBytes(raw);
      if (quotaBytes === undefined) {
        ctx.emitError(`Set-Mailbox : Cannot convert value "${raw}" to type "Microsoft.Exchange.Data.ByteQuantifiedSize".`);
        return null;
      }
      const res = exchange.setMailboxQuota(identity, quotaBytes);
      if (!res.ok) { ctx.emitError(res.message); return null; }
    }
    const mailbox = exchange.getMailbox(identity);
    return mailbox ? mailboxToPSObject(mailbox) : null;
  }
}

export class GetMailboxStatisticsCmdlet implements ICmdlet {
  readonly name = 'get-mailboxstatistics';
  readonly displayName = 'Get-MailboxStatistics';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-MailboxStatistics');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Get-MailboxStatistics : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const stats = exchange.getMailboxStatistics(identity);
    if (!stats) {
      ctx.emitError(`Get-MailboxStatistics : The operation couldn't be performed because object '${identity}' couldn't be found.`);
      return null;
    }
    return statisticsToPSObject(stats);
  }
}

export class DisableMailboxCmdlet implements ICmdlet {
  readonly name = 'disable-mailbox';
  readonly displayName = 'Disable-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Disable-Mailbox');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Disable-Mailbox : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.disableMailbox(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class RemoveMailboxCmdlet implements ICmdlet {
  readonly name = 'remove-mailbox';
  readonly displayName = 'Remove-Mailbox';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Remove-Mailbox');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Remove-Mailbox : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.removeMailbox(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

function distributionGroupToPSObject(g: DistributionGroupInfo): Record<string, PSValue> {
  return {
    Identity: g.identity,
    Name: g.identity,
    GroupType: g.type,
    PrimarySmtpAddress: g.primarySmtpAddress,
  };
}

export class NewDistributionGroupCmdlet implements ICmdlet {
  readonly name = 'new-distributiongroup';
  readonly displayName = 'New-DistributionGroup';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Type'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-DistributionGroup');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-DistributionGroup : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const typeRaw = ctx.named['type'] !== undefined ? psValueToString(ctx.named['type']) : 'Distribution';
    const type = (['Distribution', 'Security'] as const).find((t) => t.toLowerCase() === typeRaw.toLowerCase());
    if (!type) {
      ctx.emitError(`New-DistributionGroup : Cannot validate argument on parameter 'Type'. The argument "${typeRaw}" does not belong to the set "Distribution,Security".`);
      return null;
    }
    const res = exchange.newDistributionGroup(name, type);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const group = exchange.getDistributionGroup(name);
    return group ? distributionGroupToPSObject(group) : null;
  }
}

export class SetDistributionGroupCmdlet implements ICmdlet {
  readonly name = 'set-distributiongroup';
  readonly displayName = 'Set-DistributionGroup';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'PrimarySmtpAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Set-DistributionGroup');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Set-DistributionGroup : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    if (ctx.named['primarysmtpaddress'] !== undefined) {
      const res = exchange.setDistributionGroupPrimarySmtpAddress(identity, psValueToString(ctx.named['primarysmtpaddress']));
      if (!res.ok) { ctx.emitError(res.message); return null; }
    }
    const group = exchange.getDistributionGroup(identity);
    return group ? distributionGroupToPSObject(group) : null;
  }
}

export class GetDistributionGroupCmdlet implements ICmdlet {
  readonly name = 'get-distributiongroup';
  readonly displayName = 'Get-DistributionGroup';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-DistributionGroup');
    const identity = identityFrom(ctx);
    if (identity) {
      const group = exchange.getDistributionGroup(identity);
      if (!group) {
        ctx.emitError(`Get-DistributionGroup : The operation couldn't be performed because object '${identity}' couldn't be found.`);
        return null;
      }
      return distributionGroupToPSObject(group);
    }
    const groups = exchange.listDistributionGroups().map(distributionGroupToPSObject);
    return groups.length === 1 ? groups[0] : groups;
  }
}

export class AddDistributionGroupMemberCmdlet implements ICmdlet {
  readonly name = 'add-distributiongroupmember';
  readonly displayName = 'Add-DistributionGroupMember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Member'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Add-DistributionGroupMember');
    const identity = identityFrom(ctx);
    const member = psValueToString(ctx.named['member'] ?? ctx.positional[1] ?? '');
    if (!identity || !member) {
      ctx.emitError('Add-DistributionGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity, Member.');
      return null;
    }
    const res = exchange.addDistributionGroupMember(identity, member);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetDistributionGroupMemberCmdlet implements ICmdlet {
  readonly name = 'get-distributiongroupmember';
  readonly displayName = 'Get-DistributionGroupMember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-DistributionGroupMember');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Get-DistributionGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const members = exchange.getDistributionGroupMembers(identity);
    if (members === null) {
      ctx.emitError(`Get-DistributionGroupMember : The operation couldn't be performed because object '${identity}' couldn't be found.`);
      return null;
    }
    for (const m of members) ctx.emit({ Name: m, SamAccountName: m } as Record<string, PSValue>);
    return null;
  }
}
