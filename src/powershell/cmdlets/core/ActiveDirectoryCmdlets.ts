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
  AdAttributeSchemaInfo, AdObjectClassSchemaInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { parseCredentialArg } from './RemotingCmdlets';

function requireAd(ctx: CmdletContext, cmdletName: string): IAdProvider {
  if (!ctx.providers.ad) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.ad;
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
    SamAccountName: u.sam, UserPrincipalName: u.upn, DistinguishedName: u.dn,
    Enabled: u.enabled, MemberOf: u.memberOf.join(', '), Name: u.fullName || u.sam,
    ObjectClass: 'user',
  };
}
function groupToPSObject(g: AdGroupInfo): Record<string, PSValue> {
  return {
    SamAccountName: g.sam, DistinguishedName: g.dn, GroupScope: g.scope,
    Members: g.members.join(', '), ObjectClass: 'group',
  };
}
function computerToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  return { Name: c.name, DistinguishedName: c.dn, Enabled: c.enabled, ObjectClass: 'computer' };
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

function dcToPSObject(c: AdComputerInfo): Record<string, PSValue> {
  return { Name: c.name, HostName: c.name, Enabled: c.enabled, DistinguishedName: c.dn };
}

// ── New/Get/Set/Remove-ADUser ────────────────────────────────────────────────

export class NewADUserCmdlet implements ICmdlet {
  readonly name = 'new-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'SamAccountName', 'AccountPassword', 'Enabled', 'Path', 'DisplayName'] as const;

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
    const res = ad.newUser(sam, { password, fullName, path, enabled });
    if (!res.ok) { ctx.emitError(`New-ADUser : ${res.message}`); return null; }
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
    return userToPSObject(u);
  }
}

export class SetADUserCmdlet implements ICmdlet {
  readonly name = 'set-aduser';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Enabled', 'DisplayName', 'AccountPassword'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Set-ADUser');
    const identity = identityOf(ctx);
    if (!identity) { ctx.emitError("Set-ADUser : Cannot process command because of one or more missing mandatory parameters: Identity."); return null; }
    const opts: { enabled?: boolean; fullName?: string; password?: string } = {};
    if (ctx.named['enabled'] !== undefined) opts.enabled = ctx.named['enabled'] === true;
    if (ctx.named['displayname'] !== undefined) opts.fullName = psValueToString(ctx.named['displayname']);
    const password = securePasswordOf(ctx, 'accountpassword');
    if (password !== undefined) opts.password = password;
    const res = ad.setUser(identity, opts);
    if (!res.ok) ctx.emitError(`Set-ADUser : ${res.message}`);
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
    if (!res.ok) ctx.emitError(`Remove-ADUser : ${res.message}`);
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
  readonly parameters = ['Identity', 'Members'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Add-ADGroupMember');
    const identity = identityOf(ctx);
    const members = membersOf(ctx);
    if (!identity || members.length === 0) {
      ctx.emitError("Add-ADGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity Members.");
      return null;
    }
    const res = ad.addGroupMember(identity, members);
    if (!res.ok) ctx.emitError(`Add-ADGroupMember : ${res.message}`);
    return null;
  }
}

export class RemoveADGroupMemberCmdlet implements ICmdlet {
  readonly name = 'remove-adgroupmember';
  readonly aliases = [] as const;
  readonly parameters = ['Identity', 'Members', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ad = requireAd(ctx, 'Remove-ADGroupMember');
    const identity = identityOf(ctx);
    const members = membersOf(ctx);
    if (!identity || members.length === 0) {
      ctx.emitError("Remove-ADGroupMember : Cannot process command because of one or more missing mandatory parameters: Identity Members.");
      return null;
    }
    const res = ad.removeGroupMember(identity, members);
    if (!res.ok) ctx.emitError(`Remove-ADGroupMember : ${res.message}`);
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
