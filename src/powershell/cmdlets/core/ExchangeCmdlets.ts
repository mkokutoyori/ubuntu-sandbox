import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  IExchangeProvider, ExchangeServerInfo, MailboxInfo, MailboxStatisticsInfo, DistributionGroupInfo, GalEntryInfo,
  ReceiveConnectorInfo, SendConnectorInfo, TransportRuleInfo, TransportRuleConditionInfo, TransportRuleActionInfo, QueueInfo,
  MailboxDatabaseCopyInfo, ServiceHealthCheckInfo, MailflowTestResultInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireExchange(ctx: CmdletContext, cmdletName: string): IExchangeProvider {
  if (!ctx.providers.exchange) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
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

function galEntryToPSObject(e: GalEntryInfo): Record<string, PSValue> {
  return {
    DisplayName: e.displayName,
    Name: e.samAccountName,
    PrimarySmtpAddress: e.primarySmtpAddress,
    RecipientType: e.kind,
  };
}

export class GetGlobalAddressListCmdlet implements ICmdlet {
  readonly name = 'get-globaladdresslist';
  readonly displayName = 'Get-GlobalAddressList';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-GlobalAddressList');
    return exchange.getGlobalAddressList().map(galEntryToPSObject);
  }
}

function stringArrayFrom(raw: PSValue): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(psValueToString);
  return [psValueToString(raw)];
}

function receiveConnectorToPSObject(c: ReceiveConnectorInfo): Record<string, PSValue> {
  return {
    Name: c.name,
    Bindings: c.bindings.join(', '),
    RemoteIPRanges: c.remoteIpRanges.join(', '),
    AuthMechanism: c.authMechanisms.join(', '),
  };
}

export class NewReceiveConnectorCmdlet implements ICmdlet {
  readonly name = 'new-receiveconnector';
  readonly displayName = 'New-ReceiveConnector';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Bindings', 'RemoteIPRanges', 'AuthMechanism'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-ReceiveConnector');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-ReceiveConnector : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const bindings = stringArrayFrom(ctx.named['bindings']);
    if (bindings.length === 0) { ctx.emitError('New-ReceiveConnector : Cannot process command because of one or more missing mandatory parameters: Bindings.'); return null; }
    const remoteIpRanges = stringArrayFrom(ctx.named['remoteipranges']);
    const authMechanisms = stringArrayFrom(ctx.named['authmechanism']) as ReceiveConnectorInfo['authMechanisms'];
    const res = exchange.newReceiveConnector({ name, bindings, remoteIpRanges, authMechanisms });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const connector = exchange.getReceiveConnector(name);
    return connector ? receiveConnectorToPSObject(connector) : null;
  }
}

export class GetReceiveConnectorCmdlet implements ICmdlet {
  readonly name = 'get-receiveconnector';
  readonly displayName = 'Get-ReceiveConnector';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-ReceiveConnector');
    const identity = identityFrom(ctx);
    if (identity) {
      const connector = exchange.getReceiveConnector(identity);
      if (!connector) {
        ctx.emitError(`Get-ReceiveConnector : The operation couldn't be performed because object '${identity}' couldn't be found.`);
        return null;
      }
      return receiveConnectorToPSObject(connector);
    }
    const connectors = exchange.listReceiveConnectors().map(receiveConnectorToPSObject);
    return connectors.length === 1 ? connectors[0] : connectors;
  }
}

function sendConnectorToPSObject(c: SendConnectorInfo): Record<string, PSValue> {
  return {
    Name: c.name,
    AddressSpaces: c.addressSpaces.join(', '),
    SmartHosts: c.smartHosts.join(', '),
    Cost: c.costMetric,
  };
}

export class NewSendConnectorCmdlet implements ICmdlet {
  readonly name = 'new-sendconnector';
  readonly displayName = 'New-SendConnector';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'AddressSpaces', 'SmartHosts', 'Cost'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-SendConnector');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-SendConnector : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const addressSpaces = stringArrayFrom(ctx.named['addressspaces']);
    if (addressSpaces.length === 0) { ctx.emitError('New-SendConnector : Cannot process command because of one or more missing mandatory parameters: AddressSpaces.'); return null; }
    const smartHosts = stringArrayFrom(ctx.named['smarthosts']);
    const costMetric = ctx.named['cost'] !== undefined ? Number(psValueToString(ctx.named['cost'])) : 1;
    const res = exchange.newSendConnector({ name, addressSpaces, smartHosts, costMetric });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const connector = exchange.getSendConnector(name);
    return connector ? sendConnectorToPSObject(connector) : null;
  }
}

export class GetSendConnectorCmdlet implements ICmdlet {
  readonly name = 'get-sendconnector';
  readonly displayName = 'Get-SendConnector';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-SendConnector');
    const identity = identityFrom(ctx);
    if (identity) {
      const connector = exchange.getSendConnector(identity);
      if (!connector) {
        ctx.emitError(`Get-SendConnector : The operation couldn't be performed because object '${identity}' couldn't be found.`);
        return null;
      }
      return sendConnectorToPSObject(connector);
    }
    const connectors = exchange.listSendConnectors().map(sendConnectorToPSObject);
    return connectors.length === 1 ? connectors[0] : connectors;
  }
}

function transportRuleToPSObject(r: TransportRuleInfo): Record<string, PSValue> {
  return {
    Name: r.name,
    Priority: r.priority,
    State: r.enabled ? 'Enabled' : 'Disabled',
    Conditions: r.conditions.map((c) => (c.value !== undefined ? `${c.field}:${c.value}` : c.field)).join(', '),
    Actions: r.actions.map((a) => a.kind).join(', '),
  };
}

export class NewTransportRuleCmdlet implements ICmdlet {
  readonly name = 'new-transportrule';
  readonly displayName = 'New-TransportRule';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'Priority', 'From', 'SentTo', 'SubjectContainsWords', 'HasAttachment',
    'RejectMessageReasonText', 'ApplyHtmlDisclaimerText', 'RedirectMessageTo', 'BlindCopyTo', 'Enabled',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-TransportRule');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-TransportRule : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }

    const conditions: TransportRuleConditionInfo[] = [];
    if (ctx.named['from'] !== undefined) conditions.push({ field: 'From', value: psValueToString(ctx.named['from']) });
    if (ctx.named['sentto'] !== undefined) conditions.push({ field: 'To', value: psValueToString(ctx.named['sentto']) });
    const subjectWords = stringArrayFrom(ctx.named['subjectcontainswords']);
    if (subjectWords.length > 0) conditions.push({ field: 'SubjectContains', value: subjectWords[0] });
    if (ctx.named['hasattachment'] === true) conditions.push({ field: 'HasAttachment' });

    const actions: TransportRuleActionInfo[] = [];
    if (ctx.named['rejectmessagereasontext'] !== undefined) {
      actions.push({ kind: 'Reject', message: psValueToString(ctx.named['rejectmessagereasontext']) });
    }
    if (ctx.named['applyhtmldisclaimertext'] !== undefined) {
      actions.push({ kind: 'AppendDisclaimer', text: psValueToString(ctx.named['applyhtmldisclaimertext']) });
    }
    if (ctx.named['redirectmessageto'] !== undefined) {
      actions.push({ kind: 'RedirectTo', address: psValueToString(ctx.named['redirectmessageto']) });
    }
    for (const address of stringArrayFrom(ctx.named['blindcopyto'])) {
      actions.push({ kind: 'BlindCopyTo', address });
    }

    const priority = ctx.named['priority'] !== undefined
      ? Number(psValueToString(ctx.named['priority']))
      : exchange.listTransportRules().length;
    const enabled = ctx.named['enabled'] === undefined ? true : ctx.named['enabled'] === true;

    const res = exchange.newTransportRule({ name, priority, conditions, actions, enabled });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const rule = exchange.getTransportRule(name);
    return rule ? transportRuleToPSObject(rule) : null;
  }
}

export class GetTransportRuleCmdlet implements ICmdlet {
  readonly name = 'get-transportrule';
  readonly displayName = 'Get-TransportRule';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-TransportRule');
    const identity = identityFrom(ctx);
    if (identity) {
      const rule = exchange.getTransportRule(identity);
      if (!rule) {
        ctx.emitError(`Get-TransportRule : The operation couldn't be performed because object '${identity}' couldn't be found.`);
        return null;
      }
      return transportRuleToPSObject(rule);
    }
    const rules = exchange.listTransportRules().map(transportRuleToPSObject);
    return rules.length === 1 ? rules[0] : rules;
  }
}

function queueToPSObject(q: QueueInfo): Record<string, PSValue> {
  return {
    Identity: q.identity,
    NextHopDomain: q.nextHopDomain,
    MessageCount: q.messageCount,
    Status: q.status,
  };
}

export class GetQueueCmdlet implements ICmdlet {
  readonly name = 'get-queue';
  readonly displayName = 'Get-Queue';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-Queue');
    const identity = identityFrom(ctx);
    const queues = exchange.listQueues();
    if (identity) {
      const queue = queues.find((q) => q.identity.toLowerCase() === identity.toLowerCase());
      return queue ? queueToPSObject(queue) : [];
    }
    const mapped = queues.map(queueToPSObject);
    return mapped.length === 1 ? mapped[0] : mapped;
  }
}

export class RetryQueueCmdlet implements ICmdlet {
  readonly name = 'retry-queue';
  readonly displayName = 'Retry-Queue';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Retry-Queue');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Retry-Queue : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.retryQueue(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class SuspendQueueCmdlet implements ICmdlet {
  readonly name = 'suspend-queue';
  readonly displayName = 'Suspend-Queue';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Suspend-Queue');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Suspend-Queue : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.suspendQueue(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class ResumeQueueCmdlet implements ICmdlet {
  readonly name = 'resume-queue';
  readonly displayName = 'Resume-Queue';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Resume-Queue');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Resume-Queue : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = exchange.resumeQueue(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class AddMailboxPermissionCmdlet implements ICmdlet {
  readonly name = 'add-mailboxpermission';
  readonly displayName = 'Add-MailboxPermission';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'User', 'AccessRights'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Add-MailboxPermission');
    const identity = identityFrom(ctx);
    const user = psValueToString(ctx.named['user'] ?? '');
    if (!identity || !user) {
      ctx.emitError('Add-MailboxPermission : Cannot process command because of one or more missing mandatory parameters: Identity, User.');
      return null;
    }
    const res = exchange.addMailboxPermission(identity, user);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Identity: identity, User: user, AccessRights: 'FullAccess' } as Record<string, PSValue>;
  }
}

export class GetMailboxPermissionCmdlet implements ICmdlet {
  readonly name = 'get-mailboxpermission';
  readonly displayName = 'Get-MailboxPermission';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-MailboxPermission');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Get-MailboxPermission : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    return exchange.getMailboxPermissionTrustees(identity).map((user) => ({
      Identity: identity, User: user, AccessRights: 'FullAccess',
    } as Record<string, PSValue>));
  }
}

export class AddRecipientPermissionCmdlet implements ICmdlet {
  readonly name = 'add-recipientpermission';
  readonly displayName = 'Add-RecipientPermission';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Trustee', 'AccessRights'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Add-RecipientPermission');
    const identity = identityFrom(ctx);
    const trustee = psValueToString(ctx.named['trustee'] ?? '');
    if (!identity || !trustee) {
      ctx.emitError('Add-RecipientPermission : Cannot process command because of one or more missing mandatory parameters: Identity, Trustee.');
      return null;
    }
    const res = exchange.addRecipientPermission(identity, trustee);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Identity: identity, Trustee: trustee, AccessRights: 'SendAs' } as Record<string, PSValue>;
  }
}

export class GetRecipientPermissionCmdlet implements ICmdlet {
  readonly name = 'get-recipientpermission';
  readonly displayName = 'Get-RecipientPermission';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-RecipientPermission');
    const identity = identityFrom(ctx);
    if (!identity) { ctx.emitError('Get-RecipientPermission : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    return exchange.getRecipientPermissionTrustees(identity).map((trustee) => ({
      Identity: identity, Trustee: trustee, AccessRights: 'SendAs',
    } as Record<string, PSValue>));
  }
}

export class NewJournalRuleCmdlet implements ICmdlet {
  readonly name = 'new-journalrule';
  readonly displayName = 'New-JournalRule';
  readonly aliases = [] as const;
  readonly parameters = ['JournalEmailAddress', 'Scope'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-JournalRule');
    const journalEmailAddress = psValueToString(ctx.named['journalemailaddress'] ?? '');
    if (!journalEmailAddress) {
      ctx.emitError('New-JournalRule : Cannot process command because of one or more missing mandatory parameters: JournalEmailAddress.');
      return null;
    }
    const scope = ctx.named['scope'] !== undefined ? psValueToString(ctx.named['scope']) : 'Global';
    if (scope.toLowerCase() !== 'global') {
      ctx.emitError(`New-JournalRule : Cannot validate argument on parameter 'Scope'. The argument "${scope}" does not belong to the set "Global".`);
      return null;
    }
    const res = exchange.newJournalRule(journalEmailAddress);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const rule = exchange.getJournalRule();
    return rule ? transportRuleToPSObject(rule) : null;
  }
}

export class GetJournalRuleCmdlet implements ICmdlet {
  readonly name = 'get-journalrule';
  readonly displayName = 'Get-JournalRule';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-JournalRule');
    const rule = exchange.getJournalRule();
    return rule ? transportRuleToPSObject(rule) : [];
  }
}

export class NewDatabaseAvailabilityGroupCmdlet implements ICmdlet {
  readonly name = 'new-databaseavailabilitygroup';
  readonly displayName = 'New-DatabaseAvailabilityGroup';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'New-DatabaseAvailabilityGroup');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-DatabaseAvailabilityGroup : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const res = exchange.newDatabaseAvailabilityGroup(name);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Name: name } as Record<string, PSValue>;
  }
}

export class AddDatabaseAvailabilityGroupServerCmdlet implements ICmdlet {
  readonly name = 'add-databaseavailabilitygroupserver';
  readonly displayName = 'Add-DatabaseAvailabilityGroupServer';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'MailboxServer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Add-DatabaseAvailabilityGroupServer');
    const identity = identityFrom(ctx);
    const mailboxServer = psValueToString(ctx.named['mailboxserver'] ?? '');
    if (!identity || !mailboxServer) {
      ctx.emitError('Add-DatabaseAvailabilityGroupServer : Cannot process command because of one or more missing mandatory parameters: Identity, MailboxServer.');
      return null;
    }
    const res = exchange.addDatabaseAvailabilityGroupServer(identity, mailboxServer);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class AddMailboxDatabaseCopyCmdlet implements ICmdlet {
  readonly name = 'add-mailboxdatabasecopy';
  readonly displayName = 'Add-MailboxDatabaseCopy';
  readonly aliases = [] as const;
  readonly parameters = ['DatabaseAvailabilityGroup', 'Database', 'MailboxServer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Add-MailboxDatabaseCopy');
    const dag = psValueToString(ctx.named['databaseavailabilitygroup'] ?? '');
    const database = psValueToString(ctx.named['database'] ?? '');
    const mailboxServer = psValueToString(ctx.named['mailboxserver'] ?? '');
    if (!dag || !database || !mailboxServer) {
      ctx.emitError('Add-MailboxDatabaseCopy : Cannot process command because of one or more missing mandatory parameters: DatabaseAvailabilityGroup, Database, MailboxServer.');
      return null;
    }
    const res = exchange.addMailboxDatabaseCopy(dag, database, mailboxServer);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class UpdateMailboxDatabaseCopyCmdlet implements ICmdlet {
  readonly name = 'update-mailboxdatabasecopy';
  readonly displayName = 'Update-MailboxDatabaseCopy';
  readonly aliases = [] as const;
  readonly parameters = ['DatabaseAvailabilityGroup', 'Database', 'MailboxServer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Update-MailboxDatabaseCopy');
    const dag = psValueToString(ctx.named['databaseavailabilitygroup'] ?? '');
    const database = psValueToString(ctx.named['database'] ?? '');
    const mailboxServer = psValueToString(ctx.named['mailboxserver'] ?? '');
    if (!dag || !database || !mailboxServer) {
      ctx.emitError('Update-MailboxDatabaseCopy : Cannot process command because of one or more missing mandatory parameters: DatabaseAvailabilityGroup, Database, MailboxServer.');
      return null;
    }
    const res = exchange.updateMailboxDatabaseCopy(dag, database, mailboxServer);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

function databaseCopyToPSObject(c: MailboxDatabaseCopyInfo): Record<string, PSValue> {
  return {
    Database: c.database,
    MailboxServer: c.server,
    Status: c.status,
    CopyQueueLength: c.copyQueueLength,
    LastSyncedAt: c.lastSyncedAt,
  };
}

export class GetMailboxDatabaseCopyStatusCmdlet implements ICmdlet {
  readonly name = 'get-mailboxdatabasecopystatus';
  readonly displayName = 'Get-MailboxDatabaseCopyStatus';
  readonly aliases = [] as const;
  readonly parameters = ['DatabaseAvailabilityGroup', 'Database'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Get-MailboxDatabaseCopyStatus');
    const dag = psValueToString(ctx.named['databaseavailabilitygroup'] ?? '');
    if (!dag) {
      ctx.emitError('Get-MailboxDatabaseCopyStatus : Cannot process command because of one or more missing mandatory parameters: DatabaseAvailabilityGroup.');
      return null;
    }
    const database = ctx.named['database'] !== undefined ? psValueToString(ctx.named['database']) : undefined;
    const copies = exchange.getMailboxDatabaseCopyStatus(dag, database).map(databaseCopyToPSObject);
    return copies.length === 1 ? copies[0] : copies;
  }
}

function serviceHealthToPSObject(h: ServiceHealthCheckInfo): Record<string, PSValue> {
  return { ServiceName: h.serviceName, Status: h.status, Expected: h.expected };
}

export class TestServiceHealthCmdlet implements ICmdlet {
  readonly name = 'test-servicehealth';
  readonly displayName = 'Test-ServiceHealth';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Test-ServiceHealth');
    return exchange.testServiceHealth().map(serviceHealthToPSObject);
  }
}

function mailflowResultToPSObject(r: MailflowTestResultInfo): Record<string, PSValue> {
  return {
    TestMailflowResult: r.success ? 'Success' : 'Failure',
    MessageLatencyTime: r.latencyMs,
    FromMailbox: r.fromMailbox,
    ToMailbox: r.toMailbox,
    ...(r.failureReason !== undefined ? { FailureReason: r.failureReason } : {}),
  };
}

export class TestMailflowCmdlet implements ICmdlet {
  readonly name = 'test-mailflow';
  readonly displayName = 'Test-Mailflow';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'TargetMailboxIdentity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const exchange = requireExchange(ctx, 'Test-Mailflow');
    const identity = identityFrom(ctx);
    const targetMailboxIdentity = psValueToString(ctx.named['targetmailboxidentity'] ?? '');
    if (!identity || !targetMailboxIdentity) {
      ctx.emitError('Test-Mailflow : Cannot process command because of one or more missing mandatory parameters: Identity, TargetMailboxIdentity.');
      return null;
    }
    const result = exchange.testMailflow(identity, targetMailboxIdentity);
    return mailflowResultToPSObject(result);
  }
}
