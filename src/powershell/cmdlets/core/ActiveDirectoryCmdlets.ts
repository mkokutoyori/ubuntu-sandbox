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
  AdAttributeSchemaInfo, AdObjectClassSchemaInfo, AdForestInfo, AdTrustInfo,
  AdPasswordPolicyInfo, AdFineGrainedPasswordPolicyInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { parseCredentialArg } from './RemotingCmdlets';
import { WindowsSecurityAudit, type SecurityEventSink } from '@/network/devices/windows/WindowsSecurityAudit';

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

function userToPSObject(u: AdUserInfo): Record<string, PSValue> {
  return {
    SamAccountName: u.sam, UserPrincipalName: u.upn, DistinguishedName: u.dn, SID: u.sid,
    Enabled: u.enabled, MemberOf: u.memberOf.join(', '), Name: u.fullName || u.sam,
    ObjectClass: 'user', Department: u.department, Title: u.title,
    ServicePrincipalNames: [...u.servicePrincipalNames],
  };
}
function groupToPSObject(g: AdGroupInfo): Record<string, PSValue> {
  return {
    SamAccountName: g.sam, DistinguishedName: g.dn, GroupScope: g.scope,
    Members: g.members.join(', '), ObjectClass: 'group',
  };
}
function computerToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  return {
    Name: c.name, DistinguishedName: c.dn, Enabled: c.enabled, ObjectClass: 'computer',
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
  readonly parameters = ['DomainName', 'DomainNetbiosName', 'SafeModeAdministratorPassword', 'Force'] as const;

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
    const res = ad.installForest(domainName, netbiosName, password);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: 'Success.', Context: 'DCPromo', RebootRequired: false, Status: 0 } as Record<string, PSValue>;
  }
}

// ── Install-ADDSDomainController (PRD-Windows-Server-Advanced.md §5 P5) ─────

export class InstallADDSDomainControllerCmdlet implements ICmdlet {
  readonly name = 'install-addsdomaincontroller';
  readonly aliases = [] as const;
  readonly parameters = ['DomainName', 'DomainNetbiosName', 'Credential', 'Server', 'SafeModeAdministratorPassword', 'Force'] as const;

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
    const res = ad.installDomainController(domainName, netbiosName, server, username, credentialPassword, password);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: 'Success.', Context: 'DCPromo', RebootRequired: false, Status: 0 } as Record<string, PSValue>;
  }
}

// ── Get-ADDomainController ───────────────────────────────────────────────────

export class GetADDomainControllerCmdlet implements ICmdlet {
  readonly name = 'get-addomaincontroller';
  readonly aliases = [] as const;
  readonly parameters = ['Filter', 'Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
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

function dcToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  return { Name: c.name, HostName: c.name, Enabled: c.enabled, DistinguishedName: c.dn };
}

// ── New/Get/Set/Remove-ADUser ────────────────────────────────────────────────

export class NewADUserCmdlet implements ICmdlet {
  readonly name = 'new-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'SamAccountName', 'AccountPassword', 'Enabled', 'Path', 'DisplayName', 'Department', 'Title', 'Credential'] as const;

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
    const actingSam = ctx.named['credential'] !== undefined ? subjectUserOf(ctx) : undefined;
    const res = ad.newUser(sam, { password, fullName, path, enabled, department, title, actingSam });
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
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const u = ad.getUser(identity);
    if (!u) { ctx.emitError(`Get-ADUser : Cannot find an object with identity: '${identity}'.`); return null; }
    const obj = userToPSObject(u);
    const requested = stringArrayOf(ctx, 'properties').map(p => p.toLowerCase());
    if (requested.includes('passwordneverexpires')) {
      const effective = ad.getResultantPasswordPolicy(identity) ?? ad.getDefaultDomainPasswordPolicy();
      obj.PasswordNeverExpires = effective.maxPasswordAgeDays === 0;
    }
    return obj;
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
  readonly parameters = ['Identity', 'Enabled', 'DisplayName', 'AccountPassword', 'Department', 'Title', 'Add', 'Remove', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADUser');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Set-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[]; actingSam?: string } = {};
    if (ctx.named['enabled'] !== undefined) opts.enabled = ctx.named['enabled'] === true;
    if (ctx.named['displayname'] !== undefined) opts.fullName = psValueToString(ctx.named['displayname']);
    if (ctx.named['department'] !== undefined) opts.department = psValueToString(ctx.named['department']);
    if (ctx.named['title'] !== undefined) opts.title = psValueToString(ctx.named['title']);
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
    if (opts.fullName !== undefined || opts.department !== undefined || opts.title !== undefined || opts.addSpns || opts.removeSpns) {
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
  readonly parameters = ['Name', 'GroupScope', 'Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADGroup');
    const sam = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!sam) { ctx.emitError("New-ADGroup : Cannot process command because of one or more missing mandatory parameters: Name."); return null; }
    const scopeRaw = ctx.named['groupscope'] !== undefined ? psValueToString(ctx.named['groupscope']) : 'Global';
    const scope = (['DomainLocal', 'Global', 'Universal'] as const).find(s => s.toLowerCase() === scopeRaw.toLowerCase()) ?? 'Global';
    const path = ctx.named['path'] !== undefined ? psValueToString(ctx.named['path']) : undefined;
    const res = ad.newGroup(sam, scope, path);
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
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADGroup : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const g = ad.getGroup(identity);
    if (!g) { ctx.emitError(`Get-ADGroup : Cannot find an object with identity: '${identity}'.`); return null; }
    return groupToPSObject(g);
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

// ── Get-ADComputer ───────────────────────────────────────────────────────────

export class GetADComputerCmdlet implements ICmdlet {
  readonly name = 'get-adcomputer';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Filter'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADComputer');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADComputer : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const c = ad.getComputer(identity);
    if (!c) { ctx.emitError(`Get-ADComputer : Cannot find an object with identity: '${identity}'.`); return null; }
    return computerToPSObject(c);
  }
}

/** `Get-ADObject -Filter {ServicePrincipalName -like "*"}` — every user/computer carrying at least one SPN, the basis for duplicate-SPN detection scripts. `-Filter` is accepted but not deeply evaluated (matching this codebase's other AD `-Filter` cmdlets), since the one real use is enumerating SPN-bearing objects. */
export class GetADObjectCmdlet implements ICmdlet {
  readonly name = 'get-adobject';
  readonly displayName = 'Get-ADObject';
  readonly aliases = [] as const;
  readonly parameters = ['Filter', 'Properties'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Get-ADObject');
    return ad.listObjectsWithSpns().map(o => ({
      Name: o.name, ServicePrincipalName: [...o.servicePrincipalNames],
    } as Record<string, PSValue>)) as PSValue;
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
  readonly parameters = ['Name', 'Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADOrganizationalUnit');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError("New-ADOrganizationalUnit : Cannot process command because of one or more missing mandatory parameters: Name."); return null; }
    const res = ad.newOrganizationalUnit(name);
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
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Get-ADOrganizationalUnit : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const ou = ad.getOrganizationalUnit(identity);
    if (!ou) { ctx.emitError(`Get-ADOrganizationalUnit : Cannot find an object with identity: '${identity}'.`); return null; }
    return ouToPSObject(ou);
  }
}

// ── Sites (PRD-Windows-Server-Advanced.md §5 P6) ────────────────────────────

function siteToPSObject(s: AdSiteInfo): Record<string, PSValue> {
  return { Name: s.name, DistinguishedName: s.dn };
}

export class NewADReplicationSiteCmdlet implements ICmdlet {
  readonly name = 'new-adreplicationsite';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'New-ADReplicationSite');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emitError('New-ADReplicationSite : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const res = ad.newReplicationSite(name);
    if (!res.ok) { ctx.emitError(`New-ADReplicationSite : ${res.message}`); return null; }
    const sites = ad.listReplicationSites();
    const created = sites.find(s => s.name.toLowerCase() === name.toLowerCase());
    return created ? siteToPSObject(created) : null;
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

export class NewADReplicationSubnetCmdlet implements ICmdlet {
  readonly name = 'new-adreplicationsubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Site'] as const;

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
    const res = ad.newReplicationSubnet(cidr, site);
    if (!res.ok) { ctx.emitError(`New-ADReplicationSubnet : ${res.message}`); return null; }
    return null;
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
  readonly parameters = ['NewDomainName', 'DomainNetbiosName', 'ParentDomainName', 'Credential', 'Server', 'SafeModeAdministratorPassword'] as const;

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
    const res = ad.newDomain(newDomainName, netbiosName, parentDomainName, server, username, credentialPassword, password);
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

function policyToPSObject(p: AdPasswordPolicyInfo): Record<string, PSValue> {
  return {
    MinPasswordLength: p.minPasswordLength,
    PasswordHistoryCount: p.passwordHistoryCount,
    MaxPasswordAge: p.maxPasswordAgeDays,
    MinPasswordAge: p.minPasswordAgeDays,
    LockoutThreshold: p.lockoutThreshold,
    LockoutDuration: p.lockoutDurationMinutes,
    LockoutObservationWindow: p.lockoutObservationWindowMinutes,
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
    const identity = identityOf(ctx);
    if (!identity) {
      ctx.emitError('Get-ADUserResultantPasswordPolicy : Cannot process command because of one or more missing mandatory parameters: Identity.');
      return null;
    }
    const pso = ad.getResultantPasswordPolicy(identity);
    return pso ? psoToPSObject(pso) : null;
  }
}
