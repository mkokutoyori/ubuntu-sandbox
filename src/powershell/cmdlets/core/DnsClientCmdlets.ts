import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { IPAddress } from '@/network/core/types';
import type { DnsClientInterfaceRow, IDnsClientProvider } from '@/powershell/providers/PSProviders';
import type { DohServerAddress, NrptRule, NrptRuleDraft } from '@/network/devices/windows/dnsClientSettings';
import { remoteCimRefusal, notInSet } from '../cimCommon';
import { NON_INTERACTIVE_HOST, confirmationDue, type ConfirmImpact } from '../confirmation';
import {
  type DnsClientSelection, NRPT_DA_NETWORKS, NRPT_ENCODINGS, NRPT_FALLBACKS, NRPT_IPSEC_ENCRYPTIONS,
  NRPT_PROXY_TYPES, NRPT_QUERY_POLICIES, dnsClientSelectionIsEmpty, noMatchingDnsClient, selectDnsClients,
} from '@/network/devices/windows/dnsClient';

function client(ctx: CmdletContext, cmdlet: string): IDnsClientProvider {
  if (!ctx.providers.dnsClient) throw new PSRuntimeError(commandNotFoundMessage(cmdlet));
  return ctx.providers.dnsClient;
}

function fail(ctx: CmdletContext, cmdlet: string, message: string): null {
  ctx.emitError(`${cmdlet} : ${message}`);
  return null;
}

function missingParameter(ctx: CmdletContext, cmdlet: string, parameter: string): null {
  return fail(ctx, cmdlet, `Cannot process command because of one or more missing mandatory parameters: ${parameter}.`);
}

function asList(raw: PSValue | undefined): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
}

function asBoolean(raw: PSValue | undefined): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const text = psValueToString(raw).trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

function isSwitch(raw: PSValue | undefined): boolean {
  return raw === true || (raw !== undefined && raw !== null && raw !== false && asBoolean(raw) === true);
}

function choiceOf<T extends string>(
  ctx: CmdletContext, cmdlet: string, parameter: string, allowed: readonly T[],
): T | undefined | null {
  const raw = ctx.named[parameter.toLowerCase()];
  if (raw === undefined || raw === null) return undefined;
  const given = psValueToString(raw);
  const found = allowed.find(value => value.toLowerCase() === given.toLowerCase());
  if (found !== undefined) return found;
  fail(ctx, cmdlet, notInSet(parameter, given, allowed));
  return null;
}

function mayProceed(ctx: CmdletContext, cmdlet: string, impact: ConfirmImpact): boolean {
  if (!confirmationDue(ctx, impact)) return true;
  ctx.emitError(`${cmdlet} : ${NON_INTERACTIVE_HOST}`);
  return false;
}

function gpoRefusal(ctx: CmdletContext, cmdlet: string): string | null {
  if (ctx.named['gponame'] === undefined && ctx.named['server'] === undefined) return null;
  return `${cmdlet} : Group Policy based NRPT rules are not available in this simulator: omit -GpoName and -Server to configure the local policy.`;
}

const CIM_COMMON = ['CimSession', 'ThrottleLimit', 'AsJob'] as const;
const CHANGE_COMMON = [...CIM_COMMON, 'WhatIf', 'Confirm'] as const;
const INTERFACE_FILTERS = ['InterfaceAlias', 'InterfaceIndex'] as const;

function clientToPSObject(row: DnsClientInterfaceRow): Record<string, PSValue> {
  return {
    InterfaceAlias: row.interfaceAlias,
    InterfaceIndex: row.interfaceIndex,
    ConnectionSpecificSuffix: row.connectionSpecificSuffix,
    ConnectionSpecificSuffixSearchList: [],
    RegisterThisConnectionsAddress: row.registerThisConnectionsAddress,
    UseSuffixWhenRegistering: row.useSuffixWhenRegistering,
  };
}

export class GetDnsClientCmdlet implements ICmdlet {
  readonly name = 'get-dnsclient';
  readonly displayName = 'Get-DnsClient';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Gets details of the network interfaces configured on a specified computer.';
  readonly parameters = [...INTERFACE_FILTERS, 'ConnectionSpecificSuffix', 'RegisterThisConnectionsAddress',
    'UseSuffixWhenRegistering', ...CIM_COMMON] as const;
  readonly parameterValues = { InterfaceAlias: 'interfaceAlias', InterfaceIndex: 'interfaceIndex' } as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const positional = ctx.positional[0];
    const selection: DnsClientSelection = {
      interfaceAlias: asList(ctx.named['interfacealias']) ?? (positional === undefined ? undefined : [psValueToString(positional)]),
      interfaceIndex: asList(ctx.named['interfaceindex']),
      connectionSpecificSuffix: asList(ctx.named['connectionspecificsuffix']),
      registerThisConnectionsAddress: asList(ctx.named['registerthisconnectionsaddress']),
      useSuffixWhenRegistering: asList(ctx.named['usesuffixwhenregistering']),
    };
    const matched = selectDnsClients(provider.interfaces(), selection);
    if (matched.length === 0 && !dnsClientSelectionIsEmpty(selection)) {
      return fail(ctx, this.displayName, noMatchingDnsClient(selection));
    }
    return matched.map(clientToPSObject) as PSValue;
  }
}

export class SetDnsClientCmdlet implements ICmdlet {
  readonly name = 'set-dnsclient';
  readonly displayName = 'Set-DnsClient';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Sets the interface-specific DNS client configurations on the computer.';
  readonly parameters = [...INTERFACE_FILTERS, 'InputObject', 'ConnectionSpecificSuffix', 'RegisterThisConnectionsAddress',
    'UseSuffixWhenRegistering', 'ResetConnectionSpecificSuffix', 'PassThru', ...CHANGE_COMMON] as const;
  readonly parameterValues = { InterfaceAlias: 'interfaceAlias', InterfaceIndex: 'interfaceIndex' } as const;
  readonly switchParameters = ['ResetConnectionSpecificSuffix', 'PassThru'] as const;
  readonly pipelineByValue = 'InputObject';
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['interfacealias'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const targets = this.targets(ctx, provider);
    if (targets === null) return null;
    const changes = {
      connectionSuffix: isSwitch(ctx.named['resetconnectionspecificsuffix']) ? null
        : (ctx.named['connectionspecificsuffix'] === undefined ? undefined : psValueToString(ctx.named['connectionspecificsuffix'])),
      registerThisConnectionsAddress: asBoolean(ctx.named['registerthisconnectionsaddress']),
      useSuffixWhenRegistering: asBoolean(ctx.named['usesuffixwhenregistering']),
    };
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    for (const target of targets) provider.changeInterface(target.interfaceGuid, changes);
    if (!isSwitch(ctx.named['passthru'])) return null;
    const touched = new Set(targets.map(target => target.interfaceGuid));
    return provider.interfaces().filter(row => touched.has(row.interfaceGuid)).map(clientToPSObject) as PSValue;
  }

  private targets(ctx: CmdletContext, provider: IDnsClientProvider): DnsClientInterfaceRow[] | null {
    const rows = provider.interfaces();
    const input = ctx.named['inputobject'];
    if (input !== undefined && input !== null) {
      const items = (Array.isArray(input) ? input : [input]).filter((item): item is Record<string, PSValue> => item !== null && typeof item === 'object');
      const indexes = new Set(items.map(item => Number(item.InterfaceIndex)));
      return rows.filter(row => indexes.has(row.interfaceIndex));
    }
    const positional = ctx.positional[0];
    const aliases = asList(ctx.named['interfacealias']) ?? (positional === undefined ? undefined : [psValueToString(positional)]);
    const indexes = asList(ctx.named['interfaceindex']);
    if (aliases === undefined && indexes === undefined) return missingParameter(ctx, this.displayName, 'InterfaceAlias');
    const selection: DnsClientSelection = { interfaceAlias: aliases, interfaceIndex: indexes };
    const matched = selectDnsClients(rows, selection);
    return matched.length === 0 ? fail(ctx, this.displayName, noMatchingDnsClient(selection)) : matched;
  }
}

export class RegisterDnsClientCmdlet implements ICmdlet {
  readonly name = 'register-dnsclient';
  readonly displayName = 'Register-DnsClient';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Registers all of the IP addresses on the computer onto the configured DNS server.';
  readonly parameters = CHANGE_COMMON;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(): string {
    return 'DNS registration';
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    provider.registerNames();
    return null;
  }
}

function globalToPSObject(settings: ReturnType<IDnsClientProvider['globalSettings']>): Record<string, PSValue> {
  return {
    UseSuffixSearchList: true,
    SuffixSearchList: [...settings.suffixSearchList],
    UseDevolution: settings.useDevolution,
    DevolutionLevel: settings.devolutionLevel,
  };
}

export class GetDnsClientGlobalSettingCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientglobalsetting';
  readonly displayName = 'Get-DnsClientGlobalSetting';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Retrieves global DNS client settings like the suffix search list.';
  readonly parameters = CIM_COMMON;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    return globalToPSObject(provider.globalSettings());
  }
}

export class SetDnsClientGlobalSettingCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientglobalsetting';
  readonly displayName = 'Set-DnsClientGlobalSetting';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Sets the DNS client global, non-interface specific, settings.';
  readonly parameters = ['InputObject', 'SuffixSearchList', 'UseDevolution', 'DevolutionLevel', 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(): string {
    return 'DNS client global settings';
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const level = ctx.named['devolutionlevel'];
    if (level !== undefined && !/^\d+$/.test(psValueToString(level).trim())) {
      return fail(ctx, this.displayName, `Cannot process argument transformation on parameter 'DevolutionLevel'. Cannot convert value "${psValueToString(level)}" to type "System.UInt32".`);
    }
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    provider.changeGlobalSettings({
      suffixSearchList: asList(ctx.named['suffixsearchlist'])?.flatMap(entry => entry.split(',')).map(entry => entry.trim()).filter(entry => entry !== ''),
      useDevolution: asBoolean(ctx.named['usedevolution']),
      devolutionLevel: level === undefined ? undefined : Number(psValueToString(level)),
    });
    return isSwitch(ctx.named['passthru']) ? globalToPSObject(provider.globalSettings()) : null;
  }
}

function nrptToPSObject(rule: NrptRule): Record<string, PSValue> {
  return {
    Name: rule.name,
    Version: rule.version,
    Namespace: [...rule.namespaces],
    IPsecCARestriction: rule.ipsecCaRestriction,
    DirectAccessDnsServers: [...rule.directAccessDnsServers],
    DirectAccessEnabled: rule.directAccessEnabled,
    DirectAccessProxyType: rule.directAccessProxyType,
    DirectAccessProxyName: rule.directAccessProxyName,
    DirectAccessQueryIPsecEncryption: rule.directAccessQueryIpsecEncryption,
    DirectAccessQueryIPsecRequired: rule.directAccessQueryIpsecRequired,
    NameServers: [...rule.nameServers],
    DnsSecEnabled: rule.dnsSecEnabled,
    DnsSecQueryIPsecEncryption: rule.dnsSecQueryIpsecEncryption,
    DnsSecQueryIPsecRequired: rule.dnsSecQueryIpsecRequired,
    DnsSecValidationRequired: rule.dnsSecValidationRequired,
    NameEncoding: rule.nameEncoding,
    DisplayName: rule.displayName,
    Comment: rule.comment,
  };
}

const NRPT_RULE_PARAMETERS = ['DANameServers', 'DAProxyServerName', 'DAProxyType', 'DAIPsecEncryptionType', 'DnsSecIPsecEncryptionType',
  'NameServers', 'NameEncoding', 'IPsecTrustAuthority', 'Comment', 'DisplayName', 'GpoName', 'Server'] as const;

function addressProblem(ctx: CmdletContext, cmdlet: string, parameter: string, servers: string[] | undefined): string | null {
  const bad = servers?.find(server => IPAddress.tryParse(server) === null && !server.includes(':'));
  if (bad === undefined) return null;
  fail(ctx, cmdlet, `Cannot validate argument on parameter '${parameter}'. "${bad}" is not a valid IP address.`);
  return bad;
}

interface NrptChoices {
  nameEncoding?: string; daProxyType?: string; daIpsec?: string; dnsSecIpsec?: string;
}

function nrptChoices(ctx: CmdletContext, cmdlet: string): NrptChoices | null {
  const nameEncoding = choiceOf(ctx, cmdlet, 'NameEncoding', NRPT_ENCODINGS);
  const daProxyType = choiceOf(ctx, cmdlet, 'DAProxyType', NRPT_PROXY_TYPES);
  const daIpsec = choiceOf(ctx, cmdlet, 'DAIPsecEncryptionType', NRPT_IPSEC_ENCRYPTIONS);
  const dnsSecIpsec = choiceOf(ctx, cmdlet, 'DnsSecIPsecEncryptionType', NRPT_IPSEC_ENCRYPTIONS);
  if (nameEncoding === null || daProxyType === null || daIpsec === null || dnsSecIpsec === null) return null;
  return { nameEncoding, daProxyType, daIpsec, dnsSecIpsec };
}

function rulePartial(ctx: CmdletContext, choices: NrptChoices, asSwitch: boolean): Partial<NrptRuleDraft> {
  const flag = (key: string): boolean | undefined => (asSwitch
    ? (ctx.named[key] === undefined ? undefined : isSwitch(ctx.named[key]))
    : asBoolean(ctx.named[key]));
  const text = (key: string): string | undefined => (ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]));
  const draft: Record<string, unknown> = {
    namespaces: asList(ctx.named['namespace']),
    nameServers: asList(ctx.named['nameservers']),
    directAccessDnsServers: asList(ctx.named['danameservers']),
    directAccessEnabled: flag('daenable'),
    directAccessProxyType: choices.daProxyType,
    directAccessProxyName: text('daproxyservername'),
    directAccessQueryIpsecEncryption: choices.daIpsec,
    directAccessQueryIpsecRequired: flag('daipsecrequired'),
    dnsSecEnabled: flag('dnssecenable'),
    dnsSecQueryIpsecEncryption: choices.dnsSecIpsec,
    dnsSecQueryIpsecRequired: flag('dnssecipsecrequired'),
    dnsSecValidationRequired: flag('dnssecvalidationrequired'),
    ipsecCaRestriction: text('ipsectrustauthority'),
    nameEncoding: choices.nameEncoding,
    displayName: text('displayname'),
    comment: text('comment'),
  };
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)) as Partial<NrptRuleDraft>;
}

export class AddDnsClientNrptRuleCmdlet implements ICmdlet {
  readonly name = 'add-dnsclientnrptrule';
  readonly displayName = 'Add-DnsClientNrptRule';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Adds a rule to the NRPT.';
  readonly parameters = ['Namespace', 'DAEnable', 'DAIPsecRequired', 'DnsSecEnable', 'DnsSecIPsecRequired', 'DnsSecValidationRequired',
    ...NRPT_RULE_PARAMETERS, 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['DAEnable', 'DAIPsecRequired', 'DnsSecEnable', 'DnsSecIPsecRequired', 'DnsSecValidationRequired', 'PassThru'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['namespace'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    const namespaces = asList(ctx.named['namespace'] ?? (ctx.positional[0] === undefined ? undefined : ctx.positional[0]));
    if (namespaces === undefined) return missingParameter(ctx, this.displayName, 'Namespace');
    const choices = nrptChoices(ctx, this.displayName);
    if (choices === null) return null;
    if (addressProblem(ctx, this.displayName, 'NameServers', asList(ctx.named['nameservers'])) !== null) return null;
    if (addressProblem(ctx, this.displayName, 'DANameServers', asList(ctx.named['danameservers'])) !== null) return null;
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    const rule = provider.addNrptRule({ ...rulePartial(ctx, choices, true), namespaces });
    return isSwitch(ctx.named['passthru']) ? nrptToPSObject(rule) : null;
  }
}

export class GetDnsClientNrptRuleCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientnrptrule';
  readonly displayName = 'Get-DnsClientNrptRule';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Retrieves the DNS client NRPT rules.';
  readonly parameters = ['Name', 'GpoName', 'Server', ...CIM_COMMON] as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    const wanted = asList(ctx.named['name'] ?? ctx.positional[0]);
    const rules = provider.nrptRules();
    const matched = wanted === undefined ? rules : rules.filter(rule => wanted.some(name => name.toLowerCase() === rule.name.toLowerCase()));
    if (wanted !== undefined && matched.length === 0) {
      return fail(ctx, this.displayName, `No MSFT_DnsClientNrptRule objects found with property 'Name' equal to '${wanted[0]}'.  Verify the value of the property and retry.`);
    }
    return matched.map(nrptToPSObject) as PSValue;
  }
}

export class SetDnsClientNrptRuleCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientnrptrule';
  readonly displayName = 'Set-DnsClientNrptRule';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Modifies a DNS client Name Resolution Policy Table (NRPT) rule for the specified namespace.';
  readonly parameters = ['Name', 'Namespace', 'DAEnable', 'DAIPsecRequired', 'DnsSecEnable', 'DnsSecIPsecRequired', 'DnsSecValidationRequired',
    ...NRPT_RULE_PARAMETERS, 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly pipelineByPropertyName = true as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    const name = ctx.named['name'] ?? ctx.positional[0];
    if (name === undefined) return missingParameter(ctx, this.displayName, 'Name');
    const choices = nrptChoices(ctx, this.displayName);
    if (choices === null) return null;
    if (addressProblem(ctx, this.displayName, 'NameServers', asList(ctx.named['nameservers'])) !== null) return null;
    if (addressProblem(ctx, this.displayName, 'DANameServers', asList(ctx.named['danameservers'])) !== null) return null;
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    const wanted = psValueToString(name);
    const known = provider.nrptRules().find(rule => rule.name.toLowerCase() === wanted.toLowerCase());
    if (known === undefined) {
      return fail(ctx, this.displayName, `No MSFT_DnsClientNrptRule objects found with property 'Name' equal to '${wanted}'.  Verify the value of the property and retry.`);
    }
    const rule = provider.changeNrptRule(known.name, rulePartial(ctx, choices, false));
    return rule !== null && isSwitch(ctx.named['passthru']) ? nrptToPSObject(rule) : null;
  }
}

export class RemoveDnsClientNrptRuleCmdlet implements ICmdlet {
  readonly name = 'remove-dnsclientnrptrule';
  readonly displayName = 'Remove-DnsClientNrptRule';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Removes the specified DNS client NRPT rule.';
  readonly parameters = ['Name', 'GpoName', 'Server', 'Force', 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['Force', 'PassThru'] as const;
  readonly pipelineByPropertyName = true as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    const name = ctx.named['name'] ?? ctx.positional[0];
    if (name === undefined) return missingParameter(ctx, this.displayName, 'Name');
    const wanted = psValueToString(name);
    const known = provider.nrptRules().find(rule => rule.name.toLowerCase() === wanted.toLowerCase());
    if (known === undefined) {
      return fail(ctx, this.displayName, `No MSFT_DnsClientNrptRule objects found with property 'Name' equal to '${wanted}'.  Verify the value of the property and retry.`);
    }
    if (!isSwitch(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    provider.removeNrptRule(known.name);
    return isSwitch(ctx.named['passthru']) ? nrptToPSObject(known) : null;
  }
}

function policyRows(rules: readonly NrptRule[], global: ReturnType<IDnsClientProvider['nrptGlobal']>, effective: boolean): Array<Record<string, PSValue>> {
  return rules.flatMap(rule => rule.namespaces.map(namespace => ({
    Namespace: namespace,
    QueryPolicy: effective ? global.queryPolicy : '',
    SecureNameQueryFallback: effective ? global.secureNameQueryFallback : '',
    DirectAccessIPsecCARestriction: rule.ipsecCaRestriction,
    DirectAccessProxyName: rule.directAccessProxyName,
    DirectAccessDnsServers: [...rule.directAccessDnsServers],
    DirectAccessEnabled: rule.directAccessEnabled,
    DirectAccessProxyType: rule.directAccessProxyType,
    DirectAccessQueryIPsecEncryption: rule.directAccessQueryIpsecEncryption,
    DirectAccessQueryIPsecRequired: rule.directAccessQueryIpsecRequired,
    NameServers: [...rule.nameServers],
    DnsSecIPsecCARestriction: rule.ipsecCaRestriction,
    DnsSecQueryIPsecEncryption: rule.dnsSecQueryIpsecEncryption,
    DnsSecQueryIPsecRequired: rule.dnsSecQueryIpsecRequired,
    DnsSecValidationRequired: rule.dnsSecValidationRequired,
    NameEncoding: rule.nameEncoding,
  })));
}

export class GetDnsClientNrptPolicyCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientnrptpolicy';
  readonly displayName = 'Get-DnsClientNrptPolicy';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Gets the NRPT configured on a computer.';
  readonly parameters = ['Effective', 'Namespace', ...CIM_COMMON] as const;
  readonly switchParameters = ['Effective'] as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const wanted = ctx.named['namespace'] ?? ctx.positional[0];
    const rows = policyRows(provider.nrptRules(), provider.nrptGlobal(), isSwitch(ctx.named['effective']));
    const matched = wanted === undefined ? rows
      : rows.filter(row => psValueToString(row.Namespace).toLowerCase() === psValueToString(wanted).toLowerCase());
    return matched as PSValue;
  }
}

function nrptGlobalToPSObject(settings: ReturnType<IDnsClientProvider['nrptGlobal']>): Record<string, PSValue> {
  return {
    EnableDAForAllNetworks: settings.enableDAForAllNetworks,
    QueryPolicy: settings.queryPolicy,
    SecureNameQueryFallback: settings.secureNameQueryFallback,
  };
}

export class GetDnsClientNrptGlobalCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientnrptglobal';
  readonly displayName = 'Get-DnsClientNrptGlobal';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Gets the NRPT global settings.';
  readonly parameters = ['GpoName', 'Server', ...CIM_COMMON] as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    return nrptGlobalToPSObject(provider.nrptGlobal());
  }
}

export class SetDnsClientNrptGlobalCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientnrptglobal';
  readonly displayName = 'Set-DnsClientNrptGlobal';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Modifies the global Name Resolution Policy Table (NRPT) settings.';
  readonly parameters = ['EnableDAForAllNetworks', 'SecureNameQueryFallback', 'QueryPolicy', 'GpoName', 'Server', 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(): string {
    return 'NRPT global settings';
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const refusal = gpoRefusal(ctx, this.displayName);
    if (refusal !== null) { ctx.emitError(refusal); return null; }
    const enable = choiceOf(ctx, this.displayName, 'EnableDAForAllNetworks', NRPT_DA_NETWORKS);
    const fallback = choiceOf(ctx, this.displayName, 'SecureNameQueryFallback', NRPT_FALLBACKS);
    const policy = choiceOf(ctx, this.displayName, 'QueryPolicy', NRPT_QUERY_POLICIES);
    if (enable === null || fallback === null || policy === null) return null;
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    provider.changeNrptGlobal({
      ...(enable === undefined ? {} : { enableDAForAllNetworks: enable }),
      ...(fallback === undefined ? {} : { secureNameQueryFallback: fallback }),
      ...(policy === undefined ? {} : { queryPolicy: policy }),
    });
    return isSwitch(ctx.named['passthru']) ? nrptGlobalToPSObject(provider.nrptGlobal()) : null;
  }
}

function dohToPSObject(entry: DohServerAddress): Record<string, PSValue> {
  return {
    ServerAddress: entry.serverAddress,
    DohTemplate: entry.dohTemplate,
    AllowFallbackToUdp: entry.allowFallbackToUdp,
    AutoUpgrade: entry.autoUpgrade,
  };
}

function serverAddressProblem(ctx: CmdletContext, cmdlet: string, address: string): boolean {
  if (IPAddress.tryParse(address) !== null || address.includes(':')) return false;
  fail(ctx, cmdlet, `Cannot validate argument on parameter 'ServerAddress'. "${address}" is not a valid IP address.`);
  return true;
}

function templateProblem(ctx: CmdletContext, cmdlet: string, template: string | undefined): boolean {
  if (template === undefined || /^https:\/\/[^/\s]+/i.test(template)) return false;
  fail(ctx, cmdlet, `Cannot validate argument on parameter 'DohTemplate'. "${template}" is not a valid URI template: a DoH server is reached over https.`);
  return true;
}

export class AddDnsClientDohServerAddressCmdlet implements ICmdlet {
  readonly name = 'add-dnsclientdohserveraddress';
  readonly displayName = 'Add-DnsClientDohServerAddress';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Adds a DoH server configuration to the supported DoH servers.';
  readonly parameters = ['ServerAddress', 'DohTemplate', 'AllowFallbackToUdp', 'AutoUpgrade', ...CHANGE_COMMON] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['serveraddress'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const address = ctx.named['serveraddress'] ?? ctx.positional[0];
    if (address === undefined) return missingParameter(ctx, this.displayName, 'ServerAddress');
    const serverAddress = psValueToString(address);
    const template = ctx.named['dohtemplate'] ?? ctx.positional[1];
    const dohTemplate = template === undefined ? undefined : psValueToString(template);
    if (serverAddressProblem(ctx, this.displayName, serverAddress) || templateProblem(ctx, this.displayName, dohTemplate)) return null;
    if (provider.dohServers().some(entry => entry.serverAddress.toLowerCase() === serverAddress.toLowerCase())) {
      return fail(ctx, this.displayName, `The DoH server ${serverAddress} already exists.`);
    }
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    provider.saveDohServer({
      serverAddress,
      dohTemplate: dohTemplate ?? '',
      allowFallbackToUdp: asBoolean(ctx.named['allowfallbacktoudp'] ?? ctx.positional[2]) ?? false,
      autoUpgrade: asBoolean(ctx.named['autoupgrade'] ?? ctx.positional[3]) ?? false,
    });
    return null;
  }
}

export class GetDnsClientDohServerAddressCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientdohserveraddress';
  readonly displayName = 'Get-DnsClientDohServerAddress';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Gets the DoH server configuration.';
  readonly parameters = ['ServerAddress', ...CIM_COMMON] as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const wanted = asList(ctx.named['serveraddress'] ?? ctx.positional[0]);
    const entries = provider.dohServers();
    const matched = wanted === undefined ? entries
      : entries.filter(entry => wanted.some(address => address.toLowerCase() === entry.serverAddress.toLowerCase()));
    if (wanted !== undefined && matched.length === 0) {
      return fail(ctx, this.displayName, `No MSFT_DnsClientDohServerAddress objects found with property 'ServerAddress' equal to '${wanted[0]}'.  Verify the value of the property and retry.`);
    }
    return matched.map(dohToPSObject) as PSValue;
  }
}

export class SetDnsClientDohServerAddressCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientdohserveraddress';
  readonly displayName = 'Set-DnsClientDohServerAddress';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Modifies an existing DoH server configuration.';
  readonly parameters = ['ServerAddress', 'DohTemplate', 'AllowFallbackToUdp', 'AutoUpgrade', 'InputObject', 'PassThru', ...CHANGE_COMMON] as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly pipelineByValue = 'InputObject';
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['serveraddress'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const input = ctx.named['inputobject'];
    const addresses = input !== undefined && input !== null
      ? (Array.isArray(input) ? input : [input]).map(item => psValueToString((item as Record<string, PSValue>).ServerAddress))
      : asList(ctx.named['serveraddress'] ?? ctx.positional[0]);
    if (addresses === undefined) return missingParameter(ctx, this.displayName, 'ServerAddress');
    const template = ctx.named['dohtemplate'] ?? ctx.positional[1];
    const dohTemplate = template === undefined ? undefined : psValueToString(template);
    if (templateProblem(ctx, this.displayName, dohTemplate)) return null;
    const known = provider.dohServers();
    const targets: DohServerAddress[] = [];
    for (const address of addresses) {
      const entry = known.find(candidate => candidate.serverAddress.toLowerCase() === address.toLowerCase());
      if (entry === undefined) {
        return fail(ctx, this.displayName, `No MSFT_DnsClientDohServerAddress objects found with property 'ServerAddress' equal to '${address}'.  Verify the value of the property and retry.`);
      }
      targets.push(entry);
    }
    if (!mayProceed(ctx, this.displayName, 'Medium')) return null;
    const saved = targets.map(entry => ({
      serverAddress: entry.serverAddress,
      dohTemplate: dohTemplate ?? entry.dohTemplate,
      allowFallbackToUdp: asBoolean(ctx.named['allowfallbacktoudp'] ?? ctx.positional[2]) ?? false,
      autoUpgrade: asBoolean(ctx.named['autoupgrade'] ?? ctx.positional[3]) ?? false,
    }));
    for (const entry of saved) provider.saveDohServer(entry);
    return isSwitch(ctx.named['passthru']) ? saved.map(dohToPSObject) as PSValue : null;
  }
}

export class RemoveDnsClientDohServerAddressCmdlet implements ICmdlet {
  readonly name = 'remove-dnsclientdohserveraddress';
  readonly displayName = 'Remove-DnsClientDohServerAddress';
  readonly aliases = [] as const;
  readonly module = 'DnsClient';
  readonly description = 'Removes DoH server configurations from the supported DoH servers.';
  readonly parameters = ['ServerAddress', 'InputObject', ...CHANGE_COMMON] as const;
  readonly pipelineByValue = 'InputObject';
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['serveraddress'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const provider = client(ctx, this.displayName);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const input = ctx.named['inputobject'];
    const addresses = input !== undefined && input !== null
      ? (Array.isArray(input) ? input : [input]).map(item => psValueToString((item as Record<string, PSValue>).ServerAddress))
      : asList(ctx.named['serveraddress'] ?? ctx.positional[0]);
    if (addresses === undefined) return missingParameter(ctx, this.displayName, 'ServerAddress');
    const known = provider.dohServers();
    for (const address of addresses) {
      if (!known.some(entry => entry.serverAddress.toLowerCase() === address.toLowerCase())) {
        return fail(ctx, this.displayName, `No MSFT_DnsClientDohServerAddress objects found with property 'ServerAddress' equal to '${address}'.  Verify the value of the property and retry.`);
      }
    }
    if (!mayProceed(ctx, this.displayName, 'High')) return null;
    for (const address of addresses) provider.removeDohServer(known.find(entry => entry.serverAddress.toLowerCase() === address.toLowerCase())!.serverAddress);
    return null;
  }
}
