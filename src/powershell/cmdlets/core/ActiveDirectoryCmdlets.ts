/**
 * ActiveDirectoryCmdlets — Install-ADDSForest and the AD DS management
 * cmdlets (PRD-Windows-Server.md §5 P5): New/Get/Set/Remove-ADUser,
 * New/Get-ADGroup, Add/Remove-ADGroupMember, Get-ADComputer,
 * New/Get-ADOrganizationalUnit.
 *
 * Provider: ctx.providers.ad (IAdProvider), populated only for a
 * `WindowsServer` device with the AD-Domain-Services role installed —
 * see `WindowsAdAdapter`. `Install-ADDSForest` itself only needs the role
 * installed; every other AD cmdlet additionally needs this server to
 * already be a promoted domain controller.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  IAdProvider, AdUserInfo, AdGroupInfo, AdComputerInfo, AdOrgUnitInfo, AdSiteInfo,
  AdSubnetInfo, AdSiteLinkInfo,
  AdAttributeSchemaInfo, AdObjectClassSchemaInfo, AdForestInfo, AdTrustInfo,
  AdPasswordPolicyInfo, AdFineGrainedPasswordPolicyInfo, AdGenericObjectInfo,
  AdServiceAccountInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { makeTimeSpan } from './DateTimeCmdlets';
import { parseCredentialArg } from './RemotingCmdlets';
import { WindowsSecurityAudit, type SecurityEventSink } from '@/network/devices/windows/WindowsSecurityAudit';
import { type AdFunctionalLevel, adFunctionalLevelKeywords, parseAdFunctionalLevel } from '@/network/devices/windows/server/ad/adFunctionalLevels';

function requireAd(ctx: CmdletContext, cmdletName: string): IAdProvider {
  if (!ctx.providers.ad) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.ad;
}

/** AD write cmdlets feed the same Security-log audit trail as local account management (WindowsSecurityAudit), so 4720/4738/4728/etc. are real for domain objects too, not just `net user`. */
function auditSinkFor(ctx: CmdletContext): WindowsSecurityAudit | null {
  const eventLog = ctx.providers.eventLog;
  if (!eventLog) return null;
  const sink: SecurityEventSink = {
    writeEventLog: (logName, source, eventId, entryType, message, data) => {
      eventLog.writeEntry(logName, source, eventId, entryType, message, data);
      return '';
    },
  };
  return new WindowsSecurityAudit(sink);
}

/** The acting user for the audit trail: the `-Credential "user:pass"` principal when delegated, else Administrator. */
function subjectUserOf(ctx: CmdletContext): string {
  const raw = ctx.named['credential'];
  if (raw === undefined) return 'Administrator';
  const { username } = parseCredentialArg(psValueToString(raw));
  return username.includes('\\') ? username.split('\\').pop()! : username;
}

/** Unwraps a `ConvertTo-SecureString "x" -AsPlainText -Force` result (`{SecureString, Length}`) or accepts a plain string directly. */
function securePasswordOf(ctx: CmdletContext, key: string): string | undefined {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'SecureString' in (raw as Record<string, PSValue>)) {
    return psValueToString((raw as Record<string, PSValue>).SecureString);
  }
  return psValueToString(raw);
}

function identityOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['identity'] ?? ctx.positional[0] ?? '');
}

/**
 * `-Identity` that also accepts a piped/variable-held AD object (e.g. `Get-
 * ADUserResultantPasswordPolicy -Identity $_` inside a `Get-ADUser | ForEach-
 * Object {...}` pipeline) instead of only a bare string — extracts
 * SamAccountName/DistinguishedName the same way `identityOrDnOf` does for
 * `Restore-ADObject`. A single-match `-Filter` result assigned to a
 * variable is still a 1-element array (this simulator's `Get-AD*` cmdlets
 * always return arrays from `-Filter`, unlike real PowerShell's pipeline
 * auto-unwrap), so that's unwrapped first too.
 */
function identityOrObjectOf(ctx: CmdletContext): string {
  let raw = ctx.named['identity'] ?? ctx.positional[0];
  if (Array.isArray(raw) && raw.length === 1) raw = raw[0];
  if (raw !== undefined && typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, PSValue>;
    if (rec.SamAccountName !== undefined) return psValueToString(rec.SamAccountName);
    if (rec.DistinguishedName !== undefined) return psValueToString(rec.DistinguishedName);
  }
  return psValueToString(raw ?? '');
}

function installDnsOf(ctx: CmdletContext): boolean {
  return ctx.named['installdns'] !== false;
}

function pathArg(ctx: CmdletContext, key: string): string | undefined {
  return ctx.named[key] !== undefined ? psValueToString(ctx.named[key]) : undefined;
}

function functionalLevelArg(
  ctx: CmdletContext, key: string, cmdlet: string, label: string,
): AdFunctionalLevel | null | 'invalid' {
  if (ctx.named[key] === undefined) return null;
  const level = parseAdFunctionalLevel(psValueToString(ctx.named[key]));
  if (!level) {
    ctx.emitError(`${cmdlet} : Cannot bind parameter '${label}'. Acceptable values are: ${adFunctionalLevelKeywords()}, Default.`);
    return 'invalid';
  }
  return level;
}

interface AdFilterClause { prop: string; op: string; value: string }
/** A `-Filter {A -eq X -and B -eq Y -and C -eq Z}` chain — real AD filter blocks routinely combine several conditions, not just one. */
interface AdFilterChain { first: AdFilterClause; rest: Array<{ connector: 'and' | 'or'; clause: AdFilterClause }> }

/**
 * Parses ONE `-Filter {...}` script block's single command into a chain of
 * comparison clauses. Because comparison/logical operator PARAMETER names
 * (`-eq`, `-and`, ...) are kept valueless by the parser (`PS_AMBIGUOUS_
 * OPERATOR_PARAMS`, for `Where-Object`'s bare chained-comparison syntax),
 * `A -eq X -and B -eq Y` parses as ONE command whose `name` is `A`, whose
 * `parameters` are `[eq, and, eq]`, and whose `arguments` are `[X, B, Y]` —
 * i.e. the first property comes from the command name, every subsequent
 * property is itself an argument value interleaved with the connector.
 */
function parseAdFilterChain(raw: PSValue): AdFilterChain | null {
  const block = raw as unknown as { type?: string; body?: { statements?: unknown[] } };
  if (!block || block.type !== 'ScriptBlock') return null;
  const stmt = block.body?.statements?.[0] as { pipeline?: { commands?: unknown[] } } | undefined;
  const cmd = stmt?.pipeline?.commands?.[0] as {
    name?: { name?: string };
    parameters?: Array<{ name?: string }>;
    arguments?: Array<{ value?: unknown; raw?: string }>;
  } | undefined;
  let prop = cmd?.name?.name;
  const parameters = cmd?.parameters ?? [];
  const args = cmd?.arguments ?? [];
  if (!prop || parameters.length === 0) return null;

  const argValue = (arg: { value?: unknown; raw?: string } | undefined): string =>
    arg ? (arg.value !== undefined && arg.value !== null ? String(arg.value) : (arg.raw ?? '')) : '';

  let argIdx = 0;
  let first: AdFilterClause | null = null;
  const rest: Array<{ connector: 'and' | 'or'; clause: AdFilterClause }> = [];
  let pendingConnector: 'and' | 'or' | null = null;

  for (const param of parameters) {
    const name = (param.name ?? '').toLowerCase();
    if (name === 'and' || name === 'or') {
      pendingConnector = name;
      prop = argValue(args[argIdx]);
      argIdx++;
      continue;
    }
    const value = argValue(args[argIdx]);
    argIdx++;
    if (!prop) return null;
    const clause: AdFilterClause = { prop, op: name, value };
    if (!first) first = clause;
    else if (pendingConnector) { rest.push({ connector: pendingConnector, clause }); pendingConnector = null; }
    else return null;
  }
  return first ? { first, rest } : null;
}

function evalAdFilterClause(record: Record<string, PSValue>, clause: AdFilterClause): boolean {
  const key = Object.keys(record).find(k => k.toLowerCase() === clause.prop.toLowerCase());
  if (key === undefined) return true;
  const actual = psValueToString(record[key]).toLowerCase();
  const expected = clause.value.toLowerCase();
  switch (clause.op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'like': {
      const pattern = expected.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${pattern}$`).test(actual);
    }
    default: return true;
  }
}

function matchesAdFilterChain(record: Record<string, PSValue>, chain: AdFilterChain): boolean {
  let result = evalAdFilterClause(record, chain.first);
  for (const { connector, clause } of chain.rest) {
    const next = evalAdFilterClause(record, clause);
    result = connector === 'and' ? (result && next) : (result || next);
  }
  return result;
}

function filterAdObjects<T extends Record<string, PSValue>>(items: T[], filterRaw: PSValue | undefined): T[] {
  if (filterRaw === undefined) return items;
  if (typeof filterRaw !== 'object' || filterRaw === null) return items;
  const chain = parseAdFilterChain(filterRaw);
  if (!chain) return items;
  return items.filter(item => matchesAdFilterChain(item, chain));
}

function userToPSObject(u: AdUserInfo): Record<string, PSValue> {
  return {
    SamAccountName: u.sam, UserPrincipalName: u.upn, DistinguishedName: u.dn, SID: u.sid,
    Enabled: u.enabled, MemberOf: u.memberOf.join(', '), Name: u.fullName || u.sam,
    ObjectClass: 'user', Department: u.department, Title: u.title, EmailAddress: u.emailAddress,
    PasswordLastSet: (u.passwordLastSet ? new Date(u.passwordLastSet) : '') as unknown as PSValue,
    ServicePrincipalNames: [...u.servicePrincipalNames],
    ProfilePath: u.profilePath, HomeDirectory: u.homeDirectory, HomeDrive: u.homeDrive,
  };
}
function groupToPSObject(g: AdGroupInfo): Record<string, PSValue> {
  return {
    SamAccountName: g.sam, DistinguishedName: g.dn, GroupScope: g.scope, GroupCategory: g.category,
    Members: g.members.join(', '), ObjectClass: 'group',
  };
}
/** The domain DNS suffix implied by a DN's trailing `DC=` components (e.g. `CN=PC01,OU=Postes,DC=mandeng,DC=lan` → `mandeng.lan`). */
function dnsSuffixFromDn(dn: string): string {
  return dn.split(',')
    .map(rdn => rdn.trim())
    .filter(rdn => rdn.toLowerCase().startsWith('dc='))
    .map(rdn => rdn.slice(3))
    .join('.');
}

function computerToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  const suffix = dnsSuffixFromDn(c.dn);
  return {
    Name: c.name, DistinguishedName: c.dn, Enabled: c.enabled, ObjectClass: 'computer',
    DNSHostName: suffix ? `${c.name}.${suffix}` : c.name,
    ServicePrincipalNames: [...c.servicePrincipalNames],
  };
}
function ouToPSObject(ou: AdOrgUnitInfo): Record<string, PSValue> {
  return { Name: ou.name, DistinguishedName: ou.dn, ObjectClass: 'organizationalUnit' };
}

// ── Install-ADDSForest ───────────────────────────────────────────────────────

export class InstallADDSForestCmdlet implements ICmdlet {
  readonly name = 'install-addsforest';
  readonly aliases = [] as const;
  readonly parameters = ['DomainName', 'DomainNetbiosName', 'SafeModeAdministratorPassword', 'InstallDns',
    'DomainMode', 'ForestMode', 'DatabasePath', 'LogPath', 'SysvolPath', 'Force', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Install-ADDSForest');
    const domainName = psValueToString(ctx.named['domainname'] ?? ctx.positional[0] ?? '');
    if (!domainName) {
      ctx.emitError("Install-ADDSForest : Cannot process command because of one or more missing mandatory parameters: DomainName.");
      return null;
    }
    const password = securePasswordOf(ctx, 'safemodeadministratorpassword');
    if (!password) {
      ctx.emitError("Install-ADDSForest : Cannot process command because of one or more missing mandatory parameters: SafeModeAdministratorPassword.");
      return null;
    }
    const netbiosName = ctx.named['domainnetbiosname'] !== undefined ? psValueToString(ctx.named['domainnetbiosname']) : undefined;
    const forestMode = functionalLevelArg(ctx, 'forestmode', 'Install-ADDSForest', 'ForestMode');
    if (forestMode === 'invalid') return null;
    const domainMode = functionalLevelArg(ctx, 'domainmode', 'Install-ADDSForest', 'DomainMode');
    if (domainMode === 'invalid') return null;
    const res = ad.installForest(domainName, netbiosName, password, {
      installDns: installDnsOf(ctx),
      forestMode: forestMode ?? undefined,
      domainMode: domainMode ?? undefined,
      databasePath: pathArg(ctx, 'databasepath'),
      logPath: pathArg(ctx, 'logpath'),
      sysvolPath: pathArg(ctx, 'sysvolpath'),
      whatIf: ctx.named['whatif'] === true,
    });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    if (res.message) { ctx.emit(res.message); return null; }
    return { Message: 'Success.', Context: 'DCPromo', RebootRequired: false, Status: 0 } as Record<string, PSValue>;
  }
}

// ── Install-ADDSDomainController (PRD-Windows-Server-Advanced.md §5 P5) ─────

export class InstallADDSDomainControllerCmdlet implements ICmdlet {
  readonly name = 'install-addsdomaincontroller';
  readonly aliases = [] as const;
  readonly parameters = ['DomainName', 'DomainNetbiosName', 'Credential', 'Server', 'SafeModeAdministratorPassword', 'InstallDns', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Install-ADDSDomainController');
    const domainName = psValueToString(ctx.named['domainname'] ?? ctx.positional[0] ?? '');
    if (!domainName) {
      ctx.emitError('Install-ADDSDomainController : Cannot process command because of one or more missing mandatory parameters: DomainName.');
      return null;
    }
    const credentialRaw = ctx.named['credential'] !== undefined ? psValueToString(ctx.named['credential']) : '';
    if (!credentialRaw) {
      ctx.emitError('Install-ADDSDomainController : Cannot process command because of one or more missing mandatory parameters: Credential.');
      return null;
    }
    const server = ctx.named['server'] !== undefined ? psValueToString(ctx.named['server']) : undefined;
    if (!server) {
      ctx.emitError('Install-ADDSDomainController : Cannot process command because of one or more missing mandatory parameters: Server.');
      return null;
    }
    const password = securePasswordOf(ctx, 'safemodeadministratorpassword');
    if (!password) {
      ctx.emitError('Install-ADDSDomainController : Cannot process command because of one or more missing mandatory parameters: SafeModeAdministratorPassword.');
      return null;
    }
    const { username, password: credentialPassword } = parseCredentialArg(credentialRaw);
    const netbiosName = ctx.named['domainnetbiosname'] !== undefined ? psValueToString(ctx.named['domainnetbiosname']) : undefined;
    const res = ad.installDomainController(domainName, netbiosName, server, username, credentialPassword, password, { installDns: installDnsOf(ctx) });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: 'Success.', Context: 'DCPromo', RebootRequired: false, Status: 0 } as Record<string, PSValue>;
  }
}

// ── Get-ADDomainController ───────────────────────────────────────────────────

export class GetADDomainControllerCmdlet implements ICmdlet {
  readonly name = 'get-addomaincontroller';
  readonly aliases = [] as const;
  readonly parameters = ['Filter', 'Identity', 'Discover'] as const;

  execute(ctx: CmdletContext): PSValue {
    if (ctx.named['discover'] !== undefined) {
      const computer = ctx.providers.computer;
      const found = computer?.discoverDomainController();
      if (!found) { ctx.emitError('Get-ADDomainController : Cannot find any domain controller in the domain.'); return null; }
      return { HostName: found.hostName, Name: found.hostName.split('.')[0] } as Record<string, PSValue>;
    }
    const ad = requireAd(ctx, 'Get-ADDomainController');
    const dcs = ad.listDomainControllers().map(dcToPSObject);
    if (dcs.length === 0) { ctx.emitError('Get-ADDomainController : Cannot find any domain controller in the domain.'); return null; }
    return dcs.length === 1 ? dcs[0] : dcs;
  }
}

/** `Remove-ADDomainController` — accepts `-Identity` or a `Get-ADDomainController` object piped in (its `.Name`/`.HostName`). */
export class RemoveADDomainControllerCmdlet implements ICmdlet {
  readonly name = 'remove-addomaincontroller';
  readonly displayName = 'Remove-ADDomainController';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Remove-ADDomainController');
    let identity = identityOf(ctx);
    if (!identity && ctx.pipeInput !== null && typeof ctx.pipeInput === 'object' && !Array.isArray(ctx.pipeInput)) {
      const piped = ctx.pipeInput as Record<string, PSValue>;
      identity = psValueToString(piped['Name'] ?? piped['HostName'] ?? '');
    }
    if (!identity) {
      ctx.emitError('Remove-ADDomainController : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const res = ad.removeDomainController(identity);
    if (!res.ok) ctx.emitError(`Remove-ADDomainController : ${res.message}`);
    return null;
  }
}

/** The domain's DNS name from a `DC=...,DC=...` distinguished name suffix — e.g. `mandeng.lan` from `CN=DC01,OU=Domain Controllers,DC=mandeng,DC=lan`. */
function dnsNameFromDn(dn: string): string {
  return dn.split(',').filter(rdn => rdn.toUpperCase().startsWith('DC=')).map(rdn => rdn.slice(3)).join('.');
}

function dcToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  const dnsName = dnsNameFromDn(c.dn);
  return {
    Name: c.name, HostName: dnsName ? `${c.name}.${dnsName}` : c.name, Enabled: c.enabled, DistinguishedName: c.dn,
    Site: c.site ?? null, IPv4Address: c.ipv4Address ?? null,
  };
}

// ── New/Get/Set/Remove-ADUser ────────────────────────────────────────────────

export class NewADUserCmdlet implements ICmdlet {
  readonly name = 'new-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'SamAccountName', 'AccountPassword', 'Enabled', 'Path', 'DisplayName', 'Department', 'Title', 'EmailAddress', 'PasswordNeverExpires', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADUser');
    const sam = psValueToString(ctx.named['samaccountname'] ?? ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!sam) {
      ctx.emitError("New-ADUser : Cannot process command because of one or more missing mandatory parameters: Name.");
      return null;
    }
    const password = securePasswordOf(ctx, 'accountpassword') ?? '';
    const fullName = ctx.named['displayname'] !== undefined ? psValueToString(ctx.named['displayname'])
      : (ctx.named['name'] !== undefined ? psValueToString(ctx.named['name']) : undefined);
    const path = ctx.named['path'] !== undefined ? psValueToString(ctx.named['path']) : undefined;
    const enabled = ctx.named['enabled'] !== undefined ? ctx.named['enabled'] === true : undefined;
    const department = ctx.named['department'] !== undefined ? psValueToString(ctx.named['department']) : undefined;
    const title = ctx.named['title'] !== undefined ? psValueToString(ctx.named['title']) : undefined;
    const emailAddress = ctx.named['emailaddress'] !== undefined ? psValueToString(ctx.named['emailaddress']) : undefined;
    const passwordNeverExpires = ctx.named['passwordneverexpires'] === true ? true : undefined;
    const actingSam = ctx.named['credential'] !== undefined ? subjectUserOf(ctx) : undefined;
    const res = ad.newUser(sam, { password, fullName, path, enabled, department, title, emailAddress, passwordNeverExpires, actingSam });
    if (!res.ok) { ctx.emitError(`New-ADUser : ${res.message}`); return null; }
    auditSinkFor(ctx)?.accountCreated(sam, subjectUserOf(ctx));
    const u = ad.getUser(sam);
    return u ? userToPSObject(u) : null;
  }
}

export class GetADUserCmdlet implements ICmdlet {
  readonly name = 'get-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter', 'Properties'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADUser');
    // PasswordNeverExpires/PasswordExpired are real, always-queryable LDAP-
    // backed attributes (not conditional on `-Properties`) — `-Filter`
    // needs to evaluate them regardless of what's requested for display,
    // same as every other attribute. PasswordNeverExpires combines the
    // per-user UAC flag with an effective domain/FGPP policy of
    // maxPasswordAgeDays===0 (either makes the password never expire,
    // matching real AD). PasswordExpired compares PasswordLastSet against
    // the effective policy's max age.
    const now = ctx.providers.scheduledTasks?.now?.() ?? new Date();
    const withPasswordFields = (u: AdUserInfo): Record<string, PSValue> => {
      const obj = userToPSObject(u);
      const effective = ad.getResultantPasswordPolicy(u.sam) ?? ad.getDefaultDomainPasswordPolicy();
      const neverExpires = u.passwordNeverExpires || effective.maxPasswordAgeDays === 0;
      obj.PasswordNeverExpires = neverExpires;
      obj.PasswordExpired = !neverExpires && u.passwordLastSet
        ? (now.getTime() - new Date(u.passwordLastSet).getTime()) > effective.maxPasswordAgeDays * 86400000
        : false;
      return obj;
    };
    if (ctx.named['filter'] !== undefined) {
      return filterAdObjects(ad.listUsers().map(withPasswordFields), ctx.named['filter']) as PSValue;
    }
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const u = ad.getUser(identity);
    if (!u) { ctx.emitError(`Get-ADUser : Cannot find an object with identity: '${identity}'.`); return null; }
    return withPasswordFields(u);
  }
}

/** Pulls a named property (any casing) out of a `-Add`/`-Remove @{...}` hashtable argument. */
function hashtableProp(ctx: CmdletContext, argKey: string, propName: string): string[] | undefined {
  const raw = ctx.named[argKey];
  if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const h = raw as Record<string, PSValue>;
  const key = Object.keys(h).find(k => k.toLowerCase() === propName.toLowerCase());
  if (key === undefined) return undefined;
  const v = h[key];
  return (Array.isArray(v) ? v : [v]).map(psValueToString);
}

export class SetADUserCmdlet implements ICmdlet {
  readonly name = 'set-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Enabled', 'DisplayName', 'AccountPassword', 'Department', 'Title', 'Add', 'Remove', 'Credential', 'ProfilePath', 'HomeDirectory', 'HomeDrive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADUser');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Set-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[]; actingSam?: string; profilePath?: string; homeDirectory?: string; homeDrive?: string } = {};
    if (ctx.named['enabled'] !== undefined) opts.enabled = ctx.named['enabled'] === true;
    if (ctx.named['displayname'] !== undefined) opts.fullName = psValueToString(ctx.named['displayname']);
    if (ctx.named['department'] !== undefined) opts.department = psValueToString(ctx.named['department']);
    if (ctx.named['title'] !== undefined) opts.title = psValueToString(ctx.named['title']);
    if (ctx.named['profilepath'] !== undefined) opts.profilePath = psValueToString(ctx.named['profilepath']);
    if (ctx.named['homedirectory'] !== undefined) opts.homeDirectory = psValueToString(ctx.named['homedirectory']);
    if (ctx.named['homedrive'] !== undefined) opts.homeDrive = psValueToString(ctx.named['homedrive']);
    const password = securePasswordOf(ctx, 'accountpassword');
    if (password !== undefined) opts.password = password;
    const addSpns = hashtableProp(ctx, 'add', 'ServicePrincipalNames');
    if (addSpns) opts.addSpns = addSpns;
    const removeSpns = hashtableProp(ctx, 'remove', 'ServicePrincipalNames');
    if (removeSpns) opts.removeSpns = removeSpns;
    if (ctx.named['credential'] !== undefined) opts.actingSam = subjectUserOf(ctx);

    const res = ad.setUser(identity, opts);
    if (!res.ok) { ctx.emitError(`Set-ADUser : ${res.message}`); return null; }

    const audit = auditSinkFor(ctx);
    const subject = subjectUserOf(ctx);
    if (opts.enabled === true) audit?.accountEnabled(identity, subject);
    else if (opts.enabled === false) audit?.accountDisabled(identity, subject);
    if (opts.password !== undefined) audit?.passwordReset(identity, subject);
    if (opts.fullName !== undefined || opts.department !== undefined || opts.title !== undefined || opts.addSpns || opts.removeSpns
      || opts.profilePath !== undefined || opts.homeDirectory !== undefined || opts.homeDrive !== undefined) {
      audit?.accountChanged(identity, subject);
    }
    return null;
  }
}

export class RemoveADUserCmdlet implements ICmdlet {
  readonly name = 'remove-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Remove-ADUser');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Remove-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const res = ad.removeUser(identity);
    if (!res.ok) { ctx.emitError(`Remove-ADUser : ${res.message}`); return null; }
    auditSinkFor(ctx)?.accountDeleted(identity, subjectUserOf(ctx));
    return null;
  }
}

export class DisableADAccountCmdlet implements ICmdlet {
  readonly name = 'disable-adaccount';
  readonly displayName = 'Disable-ADAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Disable-ADAccount');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Disable-ADAccount : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const res = ad.setUser(identity, { enabled: false });
    if (!res.ok) { ctx.emitError(`Disable-ADAccount : ${res.message}`); return null; }
    auditSinkFor(ctx)?.accountDisabled(identity, subjectUserOf(ctx));
    return null;
  }
}

export class EnableADAccountCmdlet implements ICmdlet {
  readonly name = 'enable-adaccount';
  readonly displayName = 'Enable-ADAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Enable-ADAccount');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Enable-ADAccount : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const res = ad.setUser(identity, { enabled: true });
    if (!res.ok) { ctx.emitError(`Enable-ADAccount : ${res.message}`); return null; }
    auditSinkFor(ctx)?.accountEnabled(identity, subjectUserOf(ctx));
    return null;
  }
}

// ── New/Get-ADGroup, Add/Remove-ADGroupMember ────────────────────────────────

export class NewADGroupCmdlet implements ICmdlet {
  readonly name = 'new-adgroup';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'GroupScope', 'GroupCategory', 'Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADGroup');
    const sam = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!sam) { ctx.emitError("New-ADGroup : Cannot process command because of one or more missing mandatory parameters: Name."); return null; }
    const scopeRaw = ctx.named['groupscope'] !== undefined ? psValueToString(ctx.named['groupscope']) : 'Global';
    const scope = (['DomainLocal', 'Global', 'Universal'] as const).find(s => s.toLowerCase() === scopeRaw.toLowerCase()) ?? 'Global';
    let category: 'Security' | 'Distribution' = 'Security';
    if (ctx.named['groupcategory'] !== undefined) {
      const categoryRaw = psValueToString(ctx.named['groupcategory']);
      const matched = (['Security', 'Distribution'] as const).find(c => c.toLowerCase() === categoryRaw.toLowerCase());
      if (!matched) {
        ctx.emitError(`New-ADGroup : Cannot validate argument on parameter 'GroupCategory'. The argument "${categoryRaw}" does not belong to the set "Security,Distribution".`);
        return null;
      }
      category = matched;
    }
    const path = ctx.named['path'] !== undefined ? psValueToString(ctx.named['path']) : undefined;
    const res = ad.newGroup(sam, scope, path, category);
    if (!res.ok) { ctx.emitError(`New-ADGroup : ${res.message}`); return null; }
    const g = ad.getGroup(sam);
    return g ? groupToPSObject(g) : null;
  }
}

export class GetADGroupCmdlet implements ICmdlet {
  readonly name = 'get-adgroup';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADGroup');
    if (ctx.named['filter'] !== undefined) {
      return filterAdObjects(ad.listGroups().map(groupToPSObject), ctx.named['filter']) as PSValue;
    }
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADGroup : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const g = ad.getGroup(identity);
    if (!g) { ctx.emitError(`Get-ADGroup : Cannot find an object with identity: '${identity}'.`); return null; }
    return groupToPSObject(g);
  }
}

export class RemoveADGroupCmdlet implements ICmdlet {
  readonly name = 'remove-adgroup';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Remove-ADGroup');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Remove-ADGroup : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const res = ad.removeGroup(identity);
    if (!res.ok) { ctx.emitError(`Remove-ADGroup : ${res.message}`); return null; }
    return null;
  }
}

function membersOf(ctx: CmdletContext): string[] {
  const raw = ctx.named['members'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

export class AddADGroupMemberCmdlet implements ICmdlet {
  readonly name = 'add-adgroupmember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Members', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Add-ADGroupMember');
    const identity = identityOf(ctx);
    const members = membersOf(ctx);
    if (!identity || members.length === 0) {
      ctx.emitError("Add-ADGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity Members.");
      return null;
    }
    const res = ad.addGroupMember(identity, members);
    if (!res.ok) { ctx.emitError(`Add-ADGroupMember : ${res.message}`); return null; }
    const scope = ad.getGroup(identity)?.scope ?? 'DomainLocal';
    const audit = auditSinkFor(ctx);
    const subject = subjectUserOf(ctx);
    for (const m of members) audit?.groupMemberAdded(identity, m, scope === 'DomainLocal' ? 'Local' : scope, subject);
    return null;
  }
}

export class RemoveADGroupMemberCmdlet implements ICmdlet {
  readonly name = 'remove-adgroupmember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Members', 'Confirm', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Remove-ADGroupMember');
    const identity = identityOf(ctx);
    const members = membersOf(ctx);
    if (!identity || members.length === 0) {
      ctx.emitError("Remove-ADGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity Members.");
      return null;
    }
    const scope = ad.getGroup(identity)?.scope ?? 'DomainLocal';
    const res = ad.removeGroupMember(identity, members);
    if (!res.ok) { ctx.emitError(`Remove-ADGroupMember : ${res.message}`); return null; }
    const audit = auditSinkFor(ctx);
    const subject = subjectUserOf(ctx);
    for (const m of members) audit?.groupMemberRemoved(identity, m, scope === 'DomainLocal' ? 'Local' : scope, subject);
    return null;
  }
}

export class GetADGroupMemberCmdlet implements ICmdlet {
  readonly name = 'get-adgroupmember';
  readonly displayName = 'Get-ADGroupMember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Recursive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADGroupMember');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    if (!ad.getGroup(identity)) { ctx.emitError(`Get-ADGroupMember : Cannot find an object with identity: '${identity}'.`); return null; }
    return ad.getGroupMembers(identity).map(m => ({
      SamAccountName: m.sam, Name: m.sam, DistinguishedName: m.dn, objectClass: m.objectClass,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Get-ADComputer ───────────────────────────────────────────────────────────

export class GetADComputerCmdlet implements ICmdlet {
  readonly name = 'get-adcomputer';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter', 'SearchBase'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADComputer');
    if (ctx.named['filter'] !== undefined) {
      let items = filterAdObjects(ad.listComputers().map(computerToPSObject), ctx.named['filter']);
      if (ctx.named['searchbase'] !== undefined) {
        const base = psValueToString(ctx.named['searchbase']).toLowerCase();
        items = items.filter(o => (o.DistinguishedName as string).toLowerCase().includes(base));
      }
      return items as PSValue;
    }
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADComputer : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const c = ad.getComputer(identity);
    if (!c) { ctx.emitError(`Get-ADComputer : Cannot find an object with identity: '${identity}'.`); return null; }
    return computerToPSObject(c);
  }
}

/** `Get-ADObject -Filter {ServicePrincipalName -like "*"}` — every user/computer carrying at least one SPN, the basis for duplicate-SPN detection scripts. `-Filter` is accepted but not deeply evaluated (matching this codebase's other AD `-Filter` cmdlets), since the one real use is enumerating SPN-bearing objects. */
/** Every likely-useful property flattened onto one PS object, regardless of `-Properties` (this codebase's other `Get-AD*` cmdlets are equally permissive about `-Properties` filtering — see `Get-ADUser`). */
function genericObjectToPSObject(o: AdGenericObjectInfo): Record<string, PSValue> {
  const get = (attr: string): string => firstOfAttr(o.attributes, attr);
  // Every common property key is ALWAYS present (empty string when the
  // underlying attribute is absent) — `matchesAdFilterClause` treats a
  // MISSING key as an automatic filter pass (it can't tell "no such
  // property on this object type" from "not filtered on"), so a container
  // silently matching `-Filter {SamAccountName -eq "..."}` because it has
  // no SamAccountName at all would otherwise leak into every -Filter result.
  return {
    Name: o.name,
    DistinguishedName: o.dn,
    ObjectClass: o.objectClass,
    isDeleted: o.isDeleted,
    LastKnownParent: o.lastKnownParent ?? '',
    // Real `[DateTime]` typed property — stored as an ISO string at the
    // directory layer (like every other AD attribute), converted here so
    // `-gt`/`-lt` against `(Get-Date)...` compare chronologically instead
    // of falling back to JS's lexicographic Date-to-string coercion.
    whenChanged: (o.whenChanged ? new Date(o.whenChanged) : '') as unknown as PSValue,
    SamAccountName: get('samaccountname'),
    ServicePrincipalName: [...(o.attributes['serviceprincipalname'] ?? [])],
    Department: get('department'),
    Title: get('title'),
    EmailAddress: get('mail'),
    'msDS-DeletedObjectLifetime': get('msds-deletedobjectlifetime'),
  };
}
function firstOfAttr(attributes: Record<string, string[]>, key: string): string {
  return attributes[key.toLowerCase()]?.[0] ?? '';
}

/**
 * `Get-ADObject` — generic across every object class (PRD AD Recycle
 * Bin's `-IncludeDeletedObjects`/`-SearchBase`, plus the pre-existing
 * SPN-enumeration use `-Filter {ServicePrincipalName -like "*"}`).
 * `-Identity` returns one object (soft-deleted included only with
 * `-IncludeDeletedObjects`); `-Filter` returns every match via the same
 * generic `filterAdObjects` every other `Get-AD*` cmdlet already uses.
 */
export class GetADObjectCmdlet implements ICmdlet {
  readonly name = 'get-adobject';
  readonly displayName = 'Get-ADObject';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter', 'Properties', 'IncludeDeletedObjects', 'SearchBase'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADObject');
    const includeDeleted = ctx.named['includedeletedobjects'] === true;
    const identity = identityOf(ctx);
    if (identity) {
      const o = ad.getGenericObject(identity, includeDeleted);
      if (!o) { ctx.emitError(`Get-ADObject : Cannot find an object with identity: '${identity}'.`); return null; }
      return genericObjectToPSObject(o);
    }
    if (ctx.named['filter'] !== undefined) {
      const searchBase = ctx.named['searchbase'] !== undefined ? psValueToString(ctx.named['searchbase']) : undefined;
      const objects = ad.listGenericObjects({ includeDeleted, searchBaseDn: searchBase });
      const chain = parseAdFilterChain(ctx.named['filter']);
      if (chain && chain.rest.length === 0 && chain.first.prop.toLowerCase() === 'serviceprincipalname') {
        // Preserve the original SPN-enumeration shorthand: only objects
        // actually carrying an SPN, in the legacy {Name, ServicePrincipalName}
        // shape (`evalAdFilterClause` would otherwise treat an ABSENT
        // property as a pass, matching every object, not just SPN-bearing ones).
        return objects.filter(o => (o.attributes['serviceprincipalname'] ?? []).length > 0)
          .map(o => ({ Name: o.name, ServicePrincipalName: [...(o.attributes['serviceprincipalname'] ?? [])] } as Record<string, PSValue>)) as PSValue;
      }
      return filterAdObjects(objects.map(genericObjectToPSObject), ctx.named['filter']) as PSValue;
    }
    return [];
  }
}

/** `Set-ADObject -Identity <dn> -Replace @{attr = value}` — writes arbitrary attributes directly, e.g. `msDS-DeletedObjectLifetime` on the Configuration NC's Directory Service object. */
export class SetADObjectCmdlet implements ICmdlet {
  readonly name = 'set-adobject';
  readonly displayName = 'Set-ADObject';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Replace'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADObject');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Set-ADObject : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const raw = ctx.named['replace'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      ctx.emitError('Set-ADObject : Cannot process command because of one or more missing mandatory parameters: Replace.');
      return null;
    }
    const replace: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, PSValue>)) replace[k] = psValueToString(v);
    const res = ad.setGenericObject(identity, replace);
    if (!res.ok) { ctx.emitError(`Set-ADObject : ${res.message}`); return null; }
    return null;
  }
}

/** Accepts either a plain `-Identity "dn"` string or a piped `Get-ADObject` result object (`$DeletedUser`, whose `.DistinguishedName` names the real object). */
function identityOrDnOf(ctx: CmdletContext): string {
  let raw = ctx.named['identity'] ?? ctx.positional[0];
  // A single-match `Get-ADObject -Filter {...}` result is still a
  // one-element PSValue[] (its `filterAdObjects` return type is always an
  // array) — real PowerShell would have unwrapped that to a lone object
  // on the pipeline, but a plain variable assignment here doesn't, so
  // `$DeletedUser` from `$DeletedUser = Get-ADObject -Filter ...` is a
  // 1-element array, not a bare record.
  if (Array.isArray(raw) && raw.length === 1) raw = raw[0];
  if (raw !== undefined && typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'DistinguishedName' in (raw as Record<string, PSValue>)) {
    return psValueToString((raw as Record<string, PSValue>).DistinguishedName);
  }
  return psValueToString(raw ?? '');
}

/** `Restore-ADObject -Identity $deletedObj [-TargetPath <ou>]` (PRD AD Recycle Bin). */
export class RestoreADObjectCmdlet implements ICmdlet {
  readonly name = 'restore-adobject';
  readonly displayName = 'Restore-ADObject';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'TargetPath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Restore-ADObject');
    const identity = identityOrDnOf(ctx);
    if (!identity) { ctx.emitError("Restore-ADObject : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const targetPath = ctx.named['targetpath'] !== undefined ? psValueToString(ctx.named['targetpath']) : undefined;
    const res = ad.restoreObject(identity, targetPath);
    if (!res.ok) { ctx.emitError(`Restore-ADObject : ${res.message}`); return null; }
    return null;
  }
}

/** `Get-ADOptionalFeature -Filter {Name -eq "Recycle Bin Feature"}` — the one optional feature this simulator models. */
export class GetADOptionalFeatureCmdlet implements ICmdlet {
  readonly name = 'get-adoptionalfeature';
  readonly displayName = 'Get-ADOptionalFeature';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADOptionalFeature');
    const toPSObject = (f: { name: string; enabledScopes: string[] }): Record<string, PSValue> =>
      ({ Name: f.name, EnabledScopes: [...f.enabledScopes] });
    const name = identityOf(ctx) || 'Recycle Bin Feature';
    const feature = ad.getOptionalFeature(name);
    if (!feature) { ctx.emitError(`Get-ADOptionalFeature : Cannot find an optional feature with identity: '${name}'.`); return null; }
    if (ctx.named['filter'] !== undefined) return filterAdObjects([toPSObject(feature)], ctx.named['filter']) as PSValue;
    return toPSObject(feature);
  }
}

/** `Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target <domain>` — irreversible, matching real AD (no `Disable-ADOptionalFeature` cmdlet exists). */
export class EnableADOptionalFeatureCmdlet implements ICmdlet {
  readonly name = 'enable-adoptionalfeature';
  readonly displayName = 'Enable-ADOptionalFeature';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Scope', 'Target', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Enable-ADOptionalFeature');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Enable-ADOptionalFeature : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const scopeDn = `CN=Partitions,${ad.getConfigurationNamingContext()}`;
    const res = ad.enableOptionalFeature(identity, scopeDn);
    if (!res.ok) { ctx.emitError(`Enable-ADOptionalFeature : ${res.message}`); return null; }
    return null;
  }
}

/** `Get-ADRootDSE` — currently just `configurationNamingContext`, the one attribute `Set-ADObject`/`Get-ADObject` scripts targeting the Configuration NC actually read. */
export class GetADRootDSECmdlet implements ICmdlet {
  readonly name = 'get-adrootdse';
  readonly displayName = 'Get-ADRootDSE';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADRootDSE');
    return { configurationNamingContext: ad.getConfigurationNamingContext() } as Record<string, PSValue>;
  }
}

// ─── Managed Service Accounts (gMSA/sMSA) ──────────────────────────────────

/** `Add-KdsRootKey -EffectiveImmediately` — the real prerequisite `New-ADServiceAccount` (for a gMSA) refuses without. */
export class AddKdsRootKeyCmdlet implements ICmdlet {
  readonly name = 'add-kdsrootkey';
  readonly displayName = 'Add-KdsRootKey';
  readonly aliases = [] as const;
  readonly parameters = ['EffectiveImmediately', 'EffectiveTime'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Add-KdsRootKey');
    const key = ad.addKdsRootKey();
    return { KeyId: key.keyId, EffectiveTime: new Date(key.effectiveTime) } as Record<string, PSValue>;
  }
}

export class GetKdsRootKeyCmdlet implements ICmdlet {
  readonly name = 'get-kdsrootkey';
  readonly displayName = 'Get-KdsRootKey';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-KdsRootKey');
    const key = ad.getKdsRootKey();
    if (!key) return null;
    const created = new Date(key.effectiveTime);
    return {
      KeyId: key.keyId, EffectiveTime: created, CreationTime: created,
      IsEfficientlyDeleted: false, VersionNumber: 1, KdfAlgorithm: 'SP800_108_CTR_HMAC',
    } as Record<string, PSValue>;
  }
}

function serviceAccountToPSObject(a: AdServiceAccountInfo): Record<string, PSValue> {
  return {
    Name: a.sam.replace(/\$$/, ''),
    DistinguishedName: a.dn,
    SamAccountName: a.sam,
    ObjectClass: a.isGroupManaged ? 'msDS-GroupManagedServiceAccount' : 'msDS-ManagedServiceAccount',
    DNSHostName: a.dnsHostName,
    Description: a.description,
    ServicePrincipalNames: [...a.servicePrincipalNames],
    ManagedPasswordInterval: a.managedPasswordIntervalDays,
    PrincipalsAllowedToRetrieveManagedPassword: [...a.principalsAllowed],
    PasswordLastSet: (a.passwordLastSet ? new Date(a.passwordLastSet) : '') as unknown as PSValue,
    HostComputer: a.hostComputerDn,
  };
}

/** `New-ADServiceAccount` — a gMSA (`-PrincipalsAllowedToRetrieveManagedPassword`, multi-computer) or an sMSA (`-RestrictToSingleComputer`, linked later via `Add-ADComputerServiceAccount`). */
export class NewADServiceAccountCmdlet implements ICmdlet {
  readonly name = 'new-adserviceaccount';
  readonly displayName = 'New-ADServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'DNSHostName', 'Description', 'PrincipalsAllowedToRetrieveManagedPassword', 'ManagedPasswordIntervalInDays', 'Path', 'RestrictToSingleComputer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADServiceAccount');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const dnsHostName = psValueToString(ctx.named['dnshostname'] ?? '');
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const path = ctx.named['path'] !== undefined ? psValueToString(ctx.named['path']) : undefined;
    const principalsRaw = ctx.named['principalsallowedtoretrievemanagedpassword'];
    const principalsAllowed = principalsRaw !== undefined
      ? (Array.isArray(principalsRaw) ? principalsRaw.map(psValueToString) : [psValueToString(principalsRaw)])
      : undefined;
    const managedPasswordIntervalDays = ctx.named['managedpasswordintervalindays'] !== undefined
      ? Number(psValueToString(ctx.named['managedpasswordintervalindays'])) : undefined;
    const restrictToSingleComputer = ctx.named['restricttosinglecomputer'] === true;
    const res = ad.newServiceAccount(name, { dnsHostName, description, path, principalsAllowed, managedPasswordIntervalDays, restrictToSingleComputer });
    if (!res.ok) { ctx.emitError(`New-ADServiceAccount : ${res.message}`); return null; }
    const a = ad.getServiceAccount(name);
    return a ? serviceAccountToPSObject(a) : null;
  }
}

export class GetADServiceAccountCmdlet implements ICmdlet {
  readonly name = 'get-adserviceaccount';
  readonly displayName = 'Get-ADServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Properties'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADServiceAccount');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const a = ad.getServiceAccount(identity);
    if (!a) { ctx.emitError(`Get-ADServiceAccount : Cannot find an object with identity: '${identity}'.`); return null; }
    return serviceAccountToPSObject(a);
  }
}

/** `Set-ADServiceAccount -ServicePrincipalNames @{ Add = @(...) }`. */
export class SetADServiceAccountCmdlet implements ICmdlet {
  readonly name = 'set-adserviceaccount';
  readonly displayName = 'Set-ADServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'ServicePrincipalNames'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADServiceAccount');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Set-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const raw = ctx.named['serviceprincipalnames'];
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const rec = raw as Record<string, PSValue>;
      const addRaw = rec['Add'] ?? rec['add'];
      const addSpns = addRaw !== undefined ? (Array.isArray(addRaw) ? addRaw.map(psValueToString) : [psValueToString(addRaw)]) : [];
      if (addSpns.length) {
        const res = ad.addServiceAccountSpns(identity, addSpns);
        if (!res.ok) { ctx.emitError(`Set-ADServiceAccount : ${res.message}`); return null; }
      }
    }
    return null;
  }
}

/** `Add-ADComputerServiceAccount -Identity <computer> -ServiceAccount <sMSA>` — links an sMSA to its exclusive host computer. */
export class AddADComputerServiceAccountCmdlet implements ICmdlet {
  readonly name = 'add-adcomputerserviceaccount';
  readonly displayName = 'Add-ADComputerServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'ServiceAccount'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Add-ADComputerServiceAccount');
    const identity = identityOf(ctx);
    const serviceAccount = psValueToString(ctx.named['serviceaccount'] ?? '');
    if (!identity || !serviceAccount) {
      ctx.emitError('Add-ADComputerServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity, ServiceAccount.');
      return null;
    }
    const res = ad.addComputerServiceAccount(identity, serviceAccount);
    if (!res.ok) { ctx.emitError(`Add-ADComputerServiceAccount : ${res.message}`); return null; }
    return null;
  }
}

/** `Get-ADReplicationConnection -Filter *` — this DC's connection objects to its replication partners. */
export class GetADReplicationConnectionCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationconnection';
  readonly displayName = 'Get-ADReplicationConnection';
  readonly aliases = [] as const;
  readonly parameters = ['Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationConnection');
    return ad.listReplicationConnections().map(c => ({
      Name: c.name, AutoGenerated: c.autoGenerated,
      ReplicateFromDirectoryServer: c.replicateFromDirectoryServer,
      InterSiteTransportProtocol: c.interSiteTransportProtocol,
    } as Record<string, PSValue>)) as PSValue;
  }
}

/** `Get-ADReplicationFailure -Scope Forest` — every replication partner this DC currently has a persistent failure with; empty in a healthy lab. */
export class GetADReplicationFailureCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationfailure';
  readonly displayName = 'Get-ADReplicationFailure';
  readonly aliases = [] as const;
  readonly parameters = ['Scope', 'Target'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationFailure');
    return ad.listReplicationFailures().map(f => ({
      Server: f.server, Partner: f.partner, FirstFailureTime: f.firstFailureTime,
      FailureCount: f.failureCount, LastError: f.lastError, FailureType: f.failureType,
    } as Record<string, PSValue>)) as PSValue;
  }
}

/** `Search-ADAccount -LockedOut` — accounts real AD locked out after LockoutThreshold (default 5) bad passwords, tracked by the KDC on every failed Kerberos pre-authentication. */
export class SearchADAccountCmdlet implements ICmdlet {
  readonly name = 'search-adaccount';
  readonly displayName = 'Search-ADAccount';
  readonly aliases = [] as const;
  readonly parameters = ['LockedOut', 'AccountDisabled', 'AccountExpired'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Search-ADAccount');
    if (ctx.named['lockedout'] !== true) return [];
    return ad.listLockedOutUsers().map(u => ({
      Name: u.name, SamAccountName: u.sam, LockedOut: true, BadLogonCount: u.badPwdCount,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Set-ADComputer (PRD-Windows-Server-Advanced.md §5 P10) ──────────────────

export class SetADComputerCmdlet implements ICmdlet {
  readonly name = 'set-adcomputer';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'AllowedToDelegateTo'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADComputer');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError('Set-ADComputer : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const targets = stringArrayOf(ctx, 'allowedtodelegateto');
    const res = ad.setComputerAllowedToDelegateTo(identity, targets);
    if (!res.ok) { ctx.emitError(`Set-ADComputer : ${res.message}`); return null; }
    return null;
  }
}

export class SetADAccountPasswordCmdlet implements ICmdlet {
  readonly name = 'set-adaccountpassword';
  readonly displayName = 'Set-ADAccountPassword';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Reset', 'NewPassword', 'OldPassword', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADAccountPassword');
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Set-ADAccountPassword : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const newPassword = securePasswordOf(ctx, 'newpassword');
    if (!newPassword) {
      ctx.emitError('Set-ADAccountPassword : Cannot process command because of one or more missing mandatory parameters: NewPassword.');
      return null;
    }
    const actingSam = ctx.named['credential'] !== undefined ? subjectUserOf(ctx) : undefined;
    const res = ad.setUser(identity, { password: newPassword, actingSam });
    if (!res.ok) { ctx.emitError(`Set-ADAccountPassword : ${res.message}`); return null; }
    auditSinkFor(ctx)?.passwordReset(identity, subjectUserOf(ctx));
    return null;
  }
}

// ── New/Get-ADOrganizationalUnit ─────────────────────────────────────────────

export class NewADOrganizationalUnitCmdlet implements ICmdlet {
  readonly name = 'new-adorganizationalunit';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Path', 'Description', 'ProtectedFromAccidentalDeletion'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADOrganizationalUnit');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError("New-ADOrganizationalUnit : Cannot process command because of one or more missing mandatory parameters: Name."); return null; }
    const path = ctx.named['path'] !== undefined ? psValueToString(ctx.named['path']) : undefined;
    const res = ad.newOrganizationalUnit(name, path);
    if (!res.ok) { ctx.emitError(`New-ADOrganizationalUnit : ${res.message}`); return null; }
    const ou = ad.getOrganizationalUnit(name);
    return ou ? ouToPSObject(ou) : null;
  }
}

export class GetADOrganizationalUnitCmdlet implements ICmdlet {
  readonly name = 'get-adorganizationalunit';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADOrganizationalUnit');
    if (ctx.named['filter'] !== undefined) {
      return ad.listOrganizationalUnits().map(ouToPSObject) as PSValue;
    }
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADOrganizationalUnit : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const ou = ad.getOrganizationalUnit(identity);
    if (!ou) { ctx.emitError(`Get-ADOrganizationalUnit : Cannot find an object with identity: '${identity}'.`); return null; }
    return ouToPSObject(ou);
  }
}

// ── Sites (PRD-Windows-Server-Advanced.md §5 P6) ────────────────────────────
// No ISTG/KCC data is exposed anywhere in this section — real AD's
// `InterSiteTopologyGenerator`/`/kcc`/`/istg`/`/bridgeheads` are all
// explicitly out of scope (PRD-Repadmin.md §0.2, inherited from
// PRD-Windows-Server-Advanced.md §2.2): replication partners and site
// membership are declared explicitly (`Move-ADDirectoryServer`), never
// automatically computed/elected.

function siteToPSObject(s: AdSiteInfo): Record<string, PSValue> {
  return { Name: s.name, DistinguishedName: s.dn };
}

/** `-Identity` that also accepts a piped `Get-ADReplicationSite` object (its `.Name`). */
function pipedSiteIdentity(ctx: CmdletContext): string {
  const identity = identityOf(ctx);
  if (identity) return identity;
  if (ctx.pipeInput !== null && typeof ctx.pipeInput === 'object' && !Array.isArray(ctx.pipeInput)) {
    return psValueToString((ctx.pipeInput as Record<string, PSValue>)['Name'] ?? '');
  }
  return '';
}

export class NewADReplicationSiteCmdlet implements ICmdlet {
  readonly name = 'new-adreplicationsite';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADReplicationSite');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emitError('New-ADReplicationSite : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const res = ad.newReplicationSite(name, description);
    if (!res.ok) { ctx.emitError(`New-ADReplicationSite : ${res.message}`); return null; }
    const sites = ad.listReplicationSites();
    const created = sites.find(s => s.name.toLowerCase() === name.toLowerCase());
    return created ? siteToPSObject(created) : null;
  }
}

/** `Set-ADReplicationSite -Identity <old> -Name <new>` — the only settable field this simulator models (site descriptions/options aren't separately mutable beyond creation). */
export class SetADReplicationSiteCmdlet implements ICmdlet {
  readonly name = 'set-adreplicationsite';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADReplicationSite');
    const identity = pipedSiteIdentity(ctx);
    const newName = ctx.named['name'] !== undefined ? psValueToString(ctx.named['name']) : '';
    if (!identity || !newName) {
      ctx.emitError('Set-ADReplicationSite : Cannot process command because of one or more missing mandatory parameters: Identity Name.');
      return null;
    }
    const res = ad.renameReplicationSite(identity, newName);
    if (!res.ok) { ctx.emitError(`Set-ADReplicationSite : ${res.message}`); return null; }
    return null;
  }
}

export class GetADReplicationSiteCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationsite';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationSite');
    const sites = ad.listReplicationSites();
    const identity = identityOf(ctx);
    if (!identity) return sites.map(siteToPSObject);
    const match = sites.find(s => s.name.toLowerCase() === identity.toLowerCase());
    if (!match) { ctx.emitError(`Get-ADReplicationSite : Cannot find an object with identity: '${identity}'.`); return null; }
    return siteToPSObject(match);
  }
}

function subnetToPSObject(s: AdSubnetInfo): Record<string, PSValue> {
  return { Name: s.cidr, DistinguishedName: s.dn, Site: s.site, Description: s.description };
}

export class NewADReplicationSubnetCmdlet implements ICmdlet {
  readonly name = 'new-adreplicationsubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Site', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADReplicationSubnet');
    const cidr = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!cidr) {
      ctx.emitError('New-ADReplicationSubnet : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const site = ctx.named['site'] !== undefined ? psValueToString(ctx.named['site']) : '';
    if (!site) {
      ctx.emitError('New-ADReplicationSubnet : Cannot process command because of one or more missing mandatory parameters: Site.');
      return null;
    }
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const res = ad.newReplicationSubnet(cidr, site, description);
    if (!res.ok) { ctx.emitError(`New-ADReplicationSubnet : ${res.message}`); return null; }
    return null;
  }
}

export class GetADReplicationSubnetCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationsubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationSubnet');
    const subnets = ad.listReplicationSubnets();
    const identity = identityOf(ctx);
    if (!identity || identity === '*') return subnets.map(subnetToPSObject);
    const match = subnets.find(s => s.cidr.toLowerCase() === identity.toLowerCase());
    if (!match) { ctx.emitError(`Get-ADReplicationSubnet : Cannot find an object with identity: '${identity}'.`); return null; }
    return subnetToPSObject(match);
  }
}

// ── Site links — bookkeeping only (PRD-Repadmin.md §0.2): cost/frequency/
// transport/schedule are stored and reported exactly as an admin set them,
// never consulted to actually pace or route replication. ─────────────────

function siteLinkToPSObject(l: AdSiteLinkInfo): Record<string, PSValue> {
  return {
    Name: l.name, DistinguishedName: l.dn, SitesIncluded: [...l.sitesIncluded],
    Cost: l.cost, ReplicationFrequencyInMinutes: l.replicationFrequencyInMinutes,
    InterSiteTransportProtocol: l.interSiteTransportProtocol, Description: l.description,
  };
}

function sitesIncludedOf(ctx: CmdletContext): string[] {
  const raw = ctx.named['sitesincluded'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

export class NewADReplicationSiteLinkCmdlet implements ICmdlet {
  readonly name = 'new-adreplicationsitelink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'SitesIncluded', 'Cost', 'ReplicationFrequencyInMinutes', 'InterSiteTransportProtocol', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADReplicationSiteLink');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const sitesIncluded = sitesIncludedOf(ctx);
    if (!name || sitesIncluded.length === 0) {
      ctx.emitError('New-ADReplicationSiteLink : Cannot process command because of one or more missing mandatory parameters: Name SitesIncluded.');
      return null;
    }
    const cost = ctx.named['cost'] !== undefined ? Number(ctx.named['cost']) : undefined;
    const replicationFrequencyInMinutes = ctx.named['replicationfrequencyinminutes'] !== undefined ? Number(ctx.named['replicationfrequencyinminutes']) : undefined;
    const transportRaw = ctx.named['intersitetransportprotocol'] !== undefined ? psValueToString(ctx.named['intersitetransportprotocol']) : undefined;
    const transport = transportRaw === 'SMTP' ? 'SMTP' as const : transportRaw === 'IP' ? 'IP' as const : undefined;
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const res = ad.newReplicationSiteLink(name, sitesIncluded, { cost, replicationFrequencyInMinutes, transport, description });
    if (!res.ok) { ctx.emitError(`New-ADReplicationSiteLink : ${res.message}`); return null; }
    const link = ad.getReplicationSiteLink(name);
    return link ? siteLinkToPSObject(link) : null;
  }
}

export class GetADReplicationSiteLinkCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationsitelink';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationSiteLink');
    const identity = identityOf(ctx);
    if (!identity || identity === '*') return ad.listReplicationSiteLinks().map(siteLinkToPSObject);
    const link = ad.getReplicationSiteLink(identity);
    if (!link) { ctx.emitError(`Get-ADReplicationSiteLink : Cannot find an object with identity: '${identity}'.`); return null; }
    return siteLinkToPSObject(link);
  }
}

/** `Set-ADReplicationSiteLink -Identity <name> [-Cost] [-ReplicationFrequencyInMinutes] [-SitesIncluded] [-Description] [-ReplicationSchedule]` — `-ReplicationSchedule` is accepted (an `ActiveDirectorySchedule` object, see `MiscCmdlets.ts`'s `New-Object` branch) but nothing here stores a schedule grid; no window enforcement is modeled (PRD-Repadmin.md §0.2). */
export class SetADReplicationSiteLinkCmdlet implements ICmdlet {
  readonly name = 'set-adreplicationsitelink';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Cost', 'ReplicationFrequencyInMinutes', 'SitesIncluded', 'Description', 'ReplicationSchedule'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADReplicationSiteLink');
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Set-ADReplicationSiteLink : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const patch: { cost?: number; replicationFrequencyInMinutes?: number; sitesIncluded?: string[]; description?: string } = {};
    if (ctx.named['cost'] !== undefined) patch.cost = Number(ctx.named['cost']);
    if (ctx.named['replicationfrequencyinminutes'] !== undefined) patch.replicationFrequencyInMinutes = Number(ctx.named['replicationfrequencyinminutes']);
    if (ctx.named['sitesincluded'] !== undefined) patch.sitesIncluded = sitesIncludedOf(ctx);
    if (ctx.named['description'] !== undefined) patch.description = psValueToString(ctx.named['description']);
    const res = ad.setReplicationSiteLink(identity, patch);
    if (!res.ok) { ctx.emitError(`Set-ADReplicationSiteLink : ${res.message}`); return null; }
    return null;
  }
}

// ── Move-ADDirectoryServer (PRD-Windows-Server-Advanced.md §5 P6) ──────────

export class MoveADDirectoryServerCmdlet implements ICmdlet {
  readonly name = 'move-addirectoryserver';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Site'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Move-ADDirectoryServer');
    const identity = identityOf(ctx);
    const site = ctx.named['site'] !== undefined ? psValueToString(ctx.named['site']) : '';
    if (!identity || !site) {
      ctx.emitError('Move-ADDirectoryServer : Cannot process command because of one or more missing mandatory parameters: Identity Site.');
      return null;
    }
    const res = ad.moveDirectoryServer(identity, site);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-ADReplicationUpToDatenessVectorTable (PRD-Windows-Server-Advanced.md §5 P12) ──

export class GetADReplicationUpToDatenessVectorTableCmdlet implements ICmdlet {
  readonly name = 'get-adreplicationuptodatenessvectortable';
  readonly aliases = [] as const;
  readonly parameters = ['Target'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADReplicationUpToDatenessVectorTable');
    return ad.listUpToDatenessVector().map(row => ({
      Server: row.server, UsnFilter: row.usnFilter, LastReplicationSuccess: row.lastReplicationSuccess,
    }) as Record<string, PSValue>) as PSValue;
  }
}

// ── Extensible schema (PRD-Windows-Server-Advanced.md §5 P7, RFC 4512) ─────

function stringArrayOf(ctx: CmdletContext, key: string): string[] {
  const raw = ctx.named[key];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

export class NewADAttributeCmdlet implements ICmdlet {
  readonly name = 'new-adattribute';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'AttributeSyntax', 'SingleValued'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADAttribute');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emitError('New-ADAttribute : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const syntax = ctx.named['attributesyntax'] !== undefined ? psValueToString(ctx.named['attributesyntax']) : 'string';
    const singleValued = ctx.named['singlevalued'] !== undefined ? Boolean(ctx.named['singlevalued']) : true;
    const res = ad.newAttribute({ ldapDisplayName: name, attributeSyntax: syntax, isSingleValued: singleValued });
    if (!res.ok) { ctx.emitError(`New-ADAttribute : ${res.message}`); return null; }
    return null;
  }
}

export class NewADObjectClassCmdlet implements ICmdlet {
  readonly name = 'new-adobjectclass';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Category', 'MustContain', 'MayContain', 'SubClassOf'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADObjectClass');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emitError('New-ADObjectClass : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const categoryRaw = ctx.named['category'] !== undefined ? psValueToString(ctx.named['category']) : 'structural';
    const category = (['structural', 'auxiliary', 'abstract'] as const).includes(categoryRaw as never)
      ? (categoryRaw as 'structural' | 'auxiliary' | 'abstract') : 'structural';
    const subClassOf = ctx.named['subclassof'] !== undefined ? psValueToString(ctx.named['subclassof']) : undefined;
    const res = ad.newObjectClass({
      ldapDisplayName: name, objectClassCategory: category,
      mustContain: stringArrayOf(ctx, 'mustcontain'), mayContain: stringArrayOf(ctx, 'maycontain'),
      subClassOf,
    });
    if (!res.ok) { ctx.emitError(`New-ADObjectClass : ${res.message}`); return null; }
    return null;
  }
}

// ── Multi-domain forest (PRD-Windows-Server-Advanced.md §5 P8) ─────────────

export class NewADDomainCmdlet implements ICmdlet {
  readonly name = 'new-addomain';
  readonly aliases = [] as const;
  readonly parameters = ['NewDomainName', 'DomainNetbiosName', 'ParentDomainName', 'Credential', 'Server', 'SafeModeAdministratorPassword', 'InstallDns'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADDomain');
    const newDomainName = psValueToString(ctx.named['newdomainname'] ?? ctx.positional[0] ?? '');
    if (!newDomainName) {
      ctx.emitError('New-ADDomain : Cannot process command because of one or more missing mandatory parameters: NewDomainName.');
      return null;
    }
    const parentDomainName = ctx.named['parentdomainname'] !== undefined ? psValueToString(ctx.named['parentdomainname']) : '';
    if (!parentDomainName) {
      ctx.emitError('New-ADDomain : Cannot process command because of one or more missing mandatory parameters: ParentDomainName.');
      return null;
    }
    const credentialRaw = ctx.named['credential'] !== undefined ? psValueToString(ctx.named['credential']) : '';
    if (!credentialRaw) {
      ctx.emitError('New-ADDomain : Cannot process command because of one or more missing mandatory parameters: Credential.');
      return null;
    }
    const server = ctx.named['server'] !== undefined ? psValueToString(ctx.named['server']) : '';
    if (!server) {
      ctx.emitError('New-ADDomain : Cannot process command because of one or more missing mandatory parameters: Server.');
      return null;
    }
    const password = securePasswordOf(ctx, 'safemodeadministratorpassword');
    if (!password) {
      ctx.emitError('New-ADDomain : Cannot process command because of one or more missing mandatory parameters: SafeModeAdministratorPassword.');
      return null;
    }
    const { username, password: credentialPassword } = parseCredentialArg(credentialRaw);
    const netbiosName = ctx.named['domainnetbiosname'] !== undefined ? psValueToString(ctx.named['domainnetbiosname']) : undefined;
    const res = ad.newDomain(newDomainName, netbiosName, parentDomainName, server, username, credentialPassword, password, { installDns: installDnsOf(ctx) });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: 'Success.', Context: 'DCPromo', RebootRequired: false, Status: 0 } as Record<string, PSValue>;
  }
}

export class GetADForestCmdlet implements ICmdlet {
  readonly name = 'get-adforest';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADForest');
    const forest = ad.getForest();
    if (!forest) { ctx.emitError('Get-ADForest : Unable to contact the server.'); return null; }
    return forestToPSObject(forest);
  }
}

function forestToPSObject(f: AdForestInfo): Record<string, PSValue> {
  return {
    ForestMode: f.functionalLevel,
    Domains: f.domains.map(d => d.dnsName),
    RootDomain: f.domains.find(d => !d.parentDnsName)?.dnsName ?? '',
    SchemaMaster: f.schemaMaster,
    DomainNamingMaster: f.domainNamingMaster,
  };
}

// ── Get-ADDomain ─────────────────────────────────────────────────────────

export class GetADDomainCmdlet implements ICmdlet {
  readonly name = 'get-addomain';
  readonly displayName = 'Get-ADDomain';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADDomain');
    const domain = ad.getDomain();
    if (!domain) { ctx.emitError('Get-ADDomain : Unable to contact the server.'); return null; }
    return {
      DNSRoot: domain.dnsRoot,
      NetBIOSName: domain.netBiosName,
      DomainMode: domain.domainMode,
      InfrastructureMaster: domain.infrastructureMaster,
      PDCEmulator: domain.pdcEmulator,
      RIDMaster: domain.ridMaster,
    } as Record<string, PSValue>;
  }
}

// ── Move-ADDirectoryServerOperationMasterRole (FSMO transfer/seizure) ────

export class MoveADDirectoryServerOperationMasterRoleCmdlet implements ICmdlet {
  readonly name = 'move-addirectoryserveroperationmasterrole';
  readonly displayName = 'Move-ADDirectoryServerOperationMasterRole';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'OperationMasterRole', 'Force', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Move-ADDirectoryServerOperationMasterRole');
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Move-ADDirectoryServerOperationMasterRole : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const rolesRaw = ctx.named['operationmasterrole'];
    if (rolesRaw === undefined) {
      ctx.emitError('Move-ADDirectoryServerOperationMasterRole : Cannot process command because of one or more missing mandatory parameters: OperationMasterRole.');
      return null;
    }
    const roles = (Array.isArray(rolesRaw) ? rolesRaw : [rolesRaw]).map(psValueToString);
    const force = ctx.named['force'] === true;
    const res = ad.moveOperationMasterRole(identity, roles, force);
    if (!res.ok) ctx.emitError(`Move-ADDirectoryServerOperationMasterRole : ${res.message}`);
    return null;
  }
}

// ── Trusts + cross-realm referrals (PRD-Windows-Server-Advanced.md §5 P9) ──

const TRUST_DIRECTIONS = ['Inbound', 'Outbound', 'Bidirectional'] as const;

export class NewADTrustCmdlet implements ICmdlet {
  readonly name = 'new-adtrust';
  readonly aliases = [] as const;
  readonly parameters = ['Target', 'Direction', 'Transitive', 'Credential', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADTrust');
    const target = psValueToString(ctx.named['target'] ?? ctx.positional[0] ?? '');
    if (!target) {
      ctx.emitError('New-ADTrust : Cannot process command because of one or more missing mandatory parameters: Target.');
      return null;
    }
    const server = ctx.named['server'] !== undefined ? psValueToString(ctx.named['server']) : '';
    if (!server) {
      ctx.emitError('New-ADTrust : Cannot process command because of one or more missing mandatory parameters: Server.');
      return null;
    }
    const credentialRaw = ctx.named['credential'] !== undefined ? psValueToString(ctx.named['credential']) : '';
    if (!credentialRaw) {
      ctx.emitError('New-ADTrust : Cannot process command because of one or more missing mandatory parameters: Credential.');
      return null;
    }
    const directionRaw = ctx.named['direction'] !== undefined ? psValueToString(ctx.named['direction']) : 'Bidirectional';
    const direction = (TRUST_DIRECTIONS as readonly string[]).includes(directionRaw)
      ? (directionRaw as AdTrustInfo['direction']) : 'Bidirectional';
    const transitive = ctx.named['transitive'] === undefined ? true : Boolean(ctx.named['transitive']);
    const { username, password } = parseCredentialArg(credentialRaw);

    const res = ad.newTrust(target, server, direction, transitive, username, password);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetADTrustCmdlet implements ICmdlet {
  readonly name = 'get-adtrust';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADTrust');
    const identity = ctx.named['identity'] !== undefined ? psValueToString(ctx.named['identity']) : psValueToString(ctx.positional[0] ?? '');
    if (identity) {
      const trust = ad.getTrust(identity);
      if (!trust) { ctx.emitError(`Get-ADTrust : Cannot find a trust with identity: '${identity}'.`); return null; }
      return trustToPSObject(trust);
    }
    return ad.listTrusts().map(trustToPSObject);
  }
}

function trustToPSObject(t: AdTrustInfo): Record<string, PSValue> {
  return {
    Target: t.remoteRealm,
    Direction: t.direction,
    TrustAttributes: t.transitive ? 'transitive' : 'nonTransitive',
    ForestTransitive: t.transitive,
  };
}

// ── Password policy: Default Domain Policy + Fine-Grained (PSO) ─────────────

/** Unwraps a `New-TimeSpan -Days N` result's `.TotalDays`, or a plain number given directly. */
function timeSpanDays(ctx: CmdletContext, key: string): number | undefined {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'TotalDays' in (raw as Record<string, PSValue>)) {
    return Number((raw as Record<string, PSValue>).TotalDays);
  }
  return Number(psValueToString(raw));
}
/** Unwraps a `New-TimeSpan -Minutes N` result's `.TotalMinutes`, or a plain number given directly. */
function timeSpanMinutes(ctx: CmdletContext, key: string): number | undefined {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'TotalMinutes' in (raw as Record<string, PSValue>)) {
    return Number((raw as Record<string, PSValue>).TotalMinutes);
  }
  return Number(psValueToString(raw));
}

function passwordPolicyPatchFrom(ctx: CmdletContext): Partial<AdPasswordPolicyInfo> {
  const patch: Partial<AdPasswordPolicyInfo> = {};
  if (ctx.named['minpasswordlength'] !== undefined) patch.minPasswordLength = Number(psValueToString(ctx.named['minpasswordlength']));
  if (ctx.named['passwordhistorycount'] !== undefined) patch.passwordHistoryCount = Number(psValueToString(ctx.named['passwordhistorycount']));
  const maxAge = timeSpanDays(ctx, 'maxpasswordage'); if (maxAge !== undefined) patch.maxPasswordAgeDays = maxAge;
  const minAge = timeSpanDays(ctx, 'minpasswordage'); if (minAge !== undefined) patch.minPasswordAgeDays = minAge;
  if (ctx.named['lockoutthreshold'] !== undefined) patch.lockoutThreshold = Number(psValueToString(ctx.named['lockoutthreshold']));
  const lockDur = timeSpanMinutes(ctx, 'lockoutduration'); if (lockDur !== undefined) patch.lockoutDurationMinutes = lockDur;
  const lockWin = timeSpanMinutes(ctx, 'lockoutobservationwindow'); if (lockWin !== undefined) patch.lockoutObservationWindowMinutes = lockWin;
  if (ctx.named['complexityenabled'] !== undefined) patch.complexityEnabled = ctx.named['complexityenabled'] === true;
  if (ctx.named['reversibleencryptionenabled'] !== undefined) patch.reversibleEncryptionEnabled = ctx.named['reversibleencryptionenabled'] === true;
  return patch;
}

/**
 * Real `Get-ADDefaultDomainPasswordPolicy`/`Get-ADFineGrainedPasswordPolicy`
 * expose `MaxPasswordAge`/`MinPasswordAge`/`LockoutDuration`/
 * `LockoutObservationWindow` as `[TimeSpan]` values (not plain numbers) —
 * that's load-bearing for scripts doing `$user.PasswordLastSet + $MaxAge`
 * date arithmetic (PSRuntime's `applyPlus` Date-branch only extends a Date
 * correctly when the right-hand side is TimeSpan-shaped). Mirror that here.
 */
function policyToPSObject(p: AdPasswordPolicyInfo): Record<string, PSValue> {
  return {
    MinPasswordLength: p.minPasswordLength,
    PasswordHistoryCount: p.passwordHistoryCount,
    MaxPasswordAge: makeTimeSpan(p.maxPasswordAgeDays * 86400000) as unknown as PSValue,
    MinPasswordAge: makeTimeSpan(p.minPasswordAgeDays * 86400000) as unknown as PSValue,
    LockoutThreshold: p.lockoutThreshold,
    LockoutDuration: makeTimeSpan(p.lockoutDurationMinutes * 60000) as unknown as PSValue,
    LockoutObservationWindow: makeTimeSpan(p.lockoutObservationWindowMinutes * 60000) as unknown as PSValue,
    ComplexityEnabled: p.complexityEnabled,
    ReversibleEncryptionEnabled: p.reversibleEncryptionEnabled,
  };
}

function psoToPSObject(p: AdFineGrainedPasswordPolicyInfo): Record<string, PSValue> {
  return { Name: p.name, Precedence: p.precedence, Description: p.description, ...policyToPSObject(p) };
}

export class GetADDefaultDomainPasswordPolicyCmdlet implements ICmdlet {
  readonly name = 'get-addefaultdomainpasswordpolicy';
  readonly displayName = 'Get-ADDefaultDomainPasswordPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADDefaultDomainPasswordPolicy');
    return policyToPSObject(ad.getDefaultDomainPasswordPolicy());
  }
}

export class SetADDefaultDomainPasswordPolicyCmdlet implements ICmdlet {
  readonly name = 'set-addefaultdomainpasswordpolicy';
  readonly displayName = 'Set-ADDefaultDomainPasswordPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Identity', 'MinPasswordLength', 'PasswordHistoryCount', 'MaxPasswordAge', 'MinPasswordAge',
    'LockoutThreshold', 'LockoutDuration', 'LockoutObservationWindow', 'ComplexityEnabled', 'ReversibleEncryptionEnabled',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADDefaultDomainPasswordPolicy');
    const res = ad.setDefaultDomainPasswordPolicy(passwordPolicyPatchFrom(ctx));
    if (!res.ok) ctx.emitError(`Set-ADDefaultDomainPasswordPolicy : ${res.message}`);
    return null;
  }
}

export class NewADFineGrainedPasswordPolicyCmdlet implements ICmdlet {
  readonly name = 'new-adfinegrainedpasswordpolicy';
  readonly displayName = 'New-ADFineGrainedPasswordPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'Precedence', 'MinPasswordLength', 'PasswordHistoryCount', 'MaxPasswordAge', 'MinPasswordAge',
    'LockoutThreshold', 'LockoutDuration', 'LockoutObservationWindow', 'ComplexityEnabled', 'ReversibleEncryptionEnabled', 'Description',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADFineGrainedPasswordPolicy');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emitError('New-ADFineGrainedPasswordPolicy : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const precedence = Number(psValueToString(ctx.named['precedence'] ?? ''));
    if (!Number.isFinite(precedence) || ctx.named['precedence'] === undefined) {
      ctx.emitError('New-ADFineGrainedPasswordPolicy : Cannot process command because of one or more missing mandatory parameters: Precedence.');
      return null;
    }
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const res = ad.newFineGrainedPasswordPolicy(name, precedence, passwordPolicyPatchFrom(ctx), description);
    if (!res.ok) { ctx.emitError(`New-ADFineGrainedPasswordPolicy : ${res.message}`); return null; }
    const pso = ad.getFineGrainedPasswordPolicy(name);
    return pso ? psoToPSObject(pso) : null;
  }
}

/** `Add-ADFineGrainedPasswordPolicySubject` — subjects may be users or groups. */
export class AddADFineGrainedPasswordPolicySubjectCmdlet implements ICmdlet {
  readonly name = 'add-adfinegrainedpasswordpolicysubject';
  readonly displayName = 'Add-ADFineGrainedPasswordPolicySubject';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Subjects'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Add-ADFineGrainedPasswordPolicySubject');
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Add-ADFineGrainedPasswordPolicySubject : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const subjects = stringArrayOf(ctx, 'subjects');
    if (subjects.length === 0) {
      ctx.emitError('Add-ADFineGrainedPasswordPolicySubject : Cannot process command because of one or more missing mandatory parameters: Subjects.');
      return null;
    }
    const res = ad.addFineGrainedPasswordPolicySubject(identity, subjects);
    if (!res.ok) ctx.emitError(`Add-ADFineGrainedPasswordPolicySubject : ${res.message}`);
    return null;
  }
}

export class GetADFineGrainedPasswordPolicyCmdlet implements ICmdlet {
  readonly name = 'get-adfinegrainedpasswordpolicy';
  readonly displayName = 'Get-ADFineGrainedPasswordPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADFineGrainedPasswordPolicy');
    const identity = identityOf(ctx);
    if (identity) {
      const pso = ad.getFineGrainedPasswordPolicy(identity);
      if (!pso) { ctx.emitError(`Get-ADFineGrainedPasswordPolicy : Cannot find an object with identity: '${identity}'.`); return null; }
      return psoToPSObject(pso);
    }
    return ad.listFineGrainedPasswordPolicies().map(psoToPSObject) as PSValue;
  }
}

export class GetADFineGrainedPasswordPolicySubjectCmdlet implements ICmdlet {
  readonly name = 'get-adfinegrainedpasswordpolicysubject';
  readonly displayName = 'Get-ADFineGrainedPasswordPolicySubject';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADFineGrainedPasswordPolicySubject');
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Get-ADFineGrainedPasswordPolicySubject : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    return ad.listFineGrainedPasswordPolicySubjects(identity).map(n => ({ Name: n } as Record<string, PSValue>)) as PSValue;
  }
}

export class GetADUserResultantPasswordPolicyCmdlet implements ICmdlet {
  readonly name = 'get-aduserresultantpasswordpolicy';
  readonly displayName = 'Get-ADUserResultantPasswordPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADUserResultantPasswordPolicy');
    const identity = identityOrObjectOf(ctx);
    if (!identity) {
      ctx.emitError('Get-ADUserResultantPasswordPolicy : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const pso = ad.getResultantPasswordPolicy(identity);
    return pso ? psoToPSObject(pso) : null;
  }
}
